import { describe, expect, it, mock, spyOn } from 'bun:test';
import type { Request, Response } from 'express';
import { logger } from '../../../../src/utils/logger.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

// #5495's delete burst showed one caller can starve everything else; the same
// shape applies to listing reads: a huge offset makes SQLite scan and discard
// every skipped row, repeatable as fast as the client likes. #5330 set the
// 10k ceiling for the jobs listing; this pins the same ceiling on the
// worker-plane listing feeds (/api/observations, /api/summaries, /api/prompts,
// /api/tool-uses, /api/sessions).

let loggerSpies: ReturnType<typeof spyOn>[] = [];

function createRoutes(getObservations: (offset: number, limit: number) => unknown[]) {
  const mockSessionManager = {
    isAnySessionProcessing: mock(() => Promise.resolve(false)),
    getTotalActiveWork: mock(() => Promise.resolve(0)),
  };
  const routes = new DataRoutes(
    {} as any,
    {} as any,
    mockSessionManager as any,
    {} as any,
    {} as any,
    Date.now(),
  );
  (routes as any).paginationHelper = { getObservations: mock(getObservations) };
  return routes;
}

/** Drive the wrapped handler and resolve once res.json/status settled. */
function drive(routes: DataRoutes, query: Record<string, string>): Promise<{ status: number; body: any }> {
  let status = 200;
  let resolveJson!: (body: any) => void;
  const jsonCalled = new Promise<any>((resolve) => { resolveJson = resolve; });
  const res = {
    status: (code: number) => { status = code; return res; },
    json: (response: unknown) => { resolveJson(response); return res; },
  } as unknown as Response;
  const req = { path: '/api/observations', query } as unknown as Request;
  (routes as any).handleGetObservations(req, res);
  return jsonCalled.then((body) => ({ status, body }));
}

describe('listing offset ceiling on the worker plane (#5495 family)', () => {
  it('answers 400 when the offset exceeds the 10k listing ceiling', async () => {
    const routes = createRoutes(() => []);
    const { status, body } = await drive(routes, { offset: '9007199254740991' });
    expect(status).toBe(400);
    expect(String(body.error)).toContain('offset must be at most 10000');
    expect((routes as any).paginationHelper.getObservations).not.toHaveBeenCalled();
  });

  it('keeps an offset at the ceiling working exactly as before', async () => {
    const routes = createRoutes((offset, limit) => [{ offset, limit }]);
    const { status, body } = await drive(routes, { offset: '10000', limit: '20' });
    expect(status).toBe(200);
    expect(Array.isArray(body) && body[0].offset).toBe(10000);
    expect((routes as any).paginationHelper.getObservations).toHaveBeenCalledWith(10000, 20, undefined, undefined, undefined);
  });
});
