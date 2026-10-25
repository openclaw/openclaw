import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, expect, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";

export function useSignalHttpServer() {
  const servers: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(async (server) => {
        server.closeAllConnections();
        await server[Symbol.asyncDispose]();
      }),
    );
  });
  return async (
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
  ) => {
    const server = http.createServer((req, res) => {
      void Promise.resolve(handler(req, res)).catch((error: unknown) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    servers.push(server);
    server.on("clientError", () => {});
    const port = await listenOnLoopback(server);
    return `http://127.0.0.1:${port}`;
  };
}

// Each transport supplies its real wire fixture; only the shared authority interleaving lives here.
export async function expectPreparedHandoff(
  revoked: boolean,
  setup: (gate: {
    arrive: () => void;
    response: Promise<void>;
    assertHandoff: () => void;
  }) => Promise<{
    send: () => Promise<unknown>;
    assertCount: (count: number) => void;
    result: unknown;
  }>,
) {
  const preparing = createDeferred<void>();
  const prepared = createDeferred<void>();
  const arrived = createDeferred<void>();
  const response = createDeferred<void>();
  const caller = new AbortController();
  const failure = new Error("Signal caller ended during preparation");
  const authority = fetchRuntime.captureEffectAuthority();
  vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
    ...authority,
    async initiate(effect) {
      preparing.resolve();
      await prepared.promise;
      return authority.initiate(effect);
    },
  });
  const fixture = await setup({
    arrive: () => arrived.resolve(),
    response: response.promise,
    assertHandoff: () => caller.signal.throwIfAborted(),
  });
  let settled = false;
  const sending = fixture
    .send()
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    await Promise.race([
      preparing.promise,
      arrived.promise.then(() => {
        throw new Error("transport bypassed preparation");
      }),
    ]);
    fixture.assertCount(0);
    if (revoked) {
      caller.abort(failure);
    }
    prepared.resolve();
    if (!revoked) {
      await arrived.promise;
      expect(settled).toBe(false);
      response.resolve();
    }
    expect(await sending).toEqual(revoked ? { error: failure } : { value: fixture.result });
    fixture.assertCount(revoked ? 0 : 1);
  } finally {
    caller.abort(failure);
    prepared.resolve();
    response.resolve();
    await sending;
  }
}
