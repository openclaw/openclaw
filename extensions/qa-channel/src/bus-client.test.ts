import http, { createServer, type RequestListener } from "node:http";
import type { Socket } from "node:net";
import { Readable } from "node:stream";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQaBusState, pollQaBus, resolveQaTargetThread, sendQaBusMessage } from "./bus-client.js";

const guardedFetchCalls = vi.hoisted(
  () =>
    [] as Array<
      Parameters<typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard>[0]
    >,
);

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      guardedFetchCalls.push(params);
      return actual.fetchWithSsrFGuard(params);
    },
  };
});

const OVERSIZED_RESPONSE_BYTES = 18 * 1024 * 1024;

const stops: Array<() => Promise<void>> = [];

function send(baseUrl: string, overrides: Partial<Parameters<typeof sendQaBusMessage>[0]> = {}) {
  return sendQaBusMessage({
    baseUrl,
    accountId: "acct-a",
    to: "dm:alice",
    text: "hello",
    ...overrides,
  });
}
function poll(baseUrl: string, overrides: Partial<Parameters<typeof pollQaBus>[0]> = {}) {
  return pollQaBus({
    baseUrl,
    accountId: "acct-a",
    cursor: 0,
    acknowledgedCursor: 0,
    timeoutMs: 0,
    ...overrides,
  });
}

async function startJsonServer(
  handler: (req: { url?: string | undefined }) => { statusCode?: number; body: string },
) {
  return startServer((req, res) => {
    const response = handler({ url: req.url });
    res.writeHead(response.statusCode ?? 200, {
      "content-type": "application/json; charset=utf-8",
    });
    res.end(response.body);
  });
}

async function startServer(handler: RequestListener) {
  const server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server failed to bind");
  }
  const stop = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      for (const socket of sockets) {
        socket.destroy();
      }
    });
  stops.push(stop);
  return `http://127.0.0.1:${address.port}`;
}

async function startOversizedServer(pathname: string) {
  const closed = createDeferred<number>();
  const baseUrl = await startServer((req, res) => {
    if (req.url !== pathname) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
      return;
    }
    let sentBytes = 0;
    function* responseChunks() {
      const body = Buffer.alloc(64 * 1024, 0x61);
      yield Buffer.from('{"payload":"');
      for (let size = 0; size < OVERSIZED_RESPONSE_BYTES; size += body.length) {
        yield body;
      }
      yield Buffer.from('"}');
    }
    const chunks = Readable.from(responseChunks());
    chunks.on("data", (chunk: Buffer) => {
      sentBytes += chunk.length;
    });
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.on("close", () => {
      chunks.destroy();
      closed.resolve(sentBytes);
    });
    req.on("aborted", () => {
      res.destroy();
    });
    chunks.pipe(res);
  });
  return { baseUrl, closed: closed.promise };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timeout = createDeferred<never>();
  const timer = setTimeout(() => timeout.reject(new Error(message)), timeoutMs);
  try {
    return await Promise.race([promise, timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

describe("qa-bus client", () => {
  afterEach(async () => {
    try {
      await Promise.all(stops.splice(0).map((stop) => stop()));
    } finally {
      guardedFetchCalls.length = 0;
      vi.restoreAllMocks();
    }
  });

  it.for(["current", "aborted", "revoked", "refresh-failed"] as const)(
    "fences the native request after dispatch bookkeeping: %s",
    async (state, { signal }) => {
      let accepted = 0;
      const baseUrl = await startJsonServer(() => {
        accepted++;
        return { body: JSON.stringify({ message: { id: "current-message" } }) };
      });
      const request = vi.spyOn(http, "request");
      const refreshing = createDeferred<void>();
      const release = createDeferred<void>();
      const abort = new AbortController();
      const refusal = new Error(`QA handoff ${state}`);
      let current = true;
      const assertDirectAdapterHandoff = vi.fn(() => {
        if (!current) {
          throw refusal;
        }
      });
      const onPlatformSendDispatch = vi.fn(async () => {
        refreshing.resolve();
        await release.promise;
        if (state === "refresh-failed") {
          throw refusal;
        }
      });
      const sending = send(baseUrl, {
        signal: abort.signal,
        assertDirectAdapterHandoff,
        onPlatformSendDispatch,
      });
      const settled = sending.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            refreshing.promise,
            sending,
            "send bypassed dispatch bookkeeping",
          ),
          signal,
        );
        expect(request).not.toHaveBeenCalled();
        expect(accepted).toBe(0);
        if (state === "aborted") {
          abort.abort(refusal);
        } else if (state === "revoked") {
          current = false;
        }
        release.resolve();
        const outcome = await withinTest(settled, signal);
        expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledTimes(state === "current" ? 1 : 0);
        expect(accepted).toBe(state === "current" ? 1 : 0);
        if (state === "current") {
          expect(outcome).toEqual({
            status: "fulfilled",
            value: { message: { id: "current-message" } },
          });
          const finalFence = assertDirectAdapterHandoff.mock.invocationCallOrder.at(-1)!;
          expect(onPlatformSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(finalFence);
          expect(finalFence).toBeLessThan(request.mock.invocationCallOrder[0]!);
        } else {
          expect(outcome).toMatchObject({
            status: "rejected",
            error: expect.any(PlatformMessageNotDispatchedError),
          });
          expect(
            outcome.status === "rejected" &&
              outcome.error instanceof PlatformMessageNotDispatchedError &&
              outcome.error.cause,
          ).toBe(refusal);
          if (state === "revoked") {
            expect(assertDirectAdapterHandoff.mock.invocationCallOrder.at(-1)!).toBeGreaterThan(
              onPlatformSendDispatch.mock.invocationCallOrder[0]!,
            );
          }
        }
      } finally {
        release.resolve();
        abort.abort();
        await settled;
      }
    },
  );

  it("does not classify a lost response after request acceptance as not dispatched", async () => {
    let accepted = 0;
    const baseUrl = await startServer((req) => {
      accepted++;
      req.destroy();
    });
    const request = vi.spyOn(http, "request");
    const onPlatformSendDispatch = vi.fn(async () => {});
    await expect(send(baseUrl, { onPlatformSendDispatch })).rejects.not.toBeInstanceOf(
      PlatformMessageNotDispatchedError,
    );
    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(accepted).toBe(1);
  });

  it.each([false, true])(
    "prepares the outbound POST before handoff (refused=%s)",
    async (refused) => {
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const arrived = createDeferred<void>();
      const response = createDeferred<void>();
      const refusal = new Error("QA message authority ended");
      const authority = fetchRuntime.captureEffectAuthority();
      vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          if (refused) {
            throw refusal;
          }
          return authority.initiate(effect);
        },
      });
      const baseUrl = await startServer((_req, res) => {
        arrived.resolve();
        void response.promise.then(() => {
          res.end(JSON.stringify({ message: { id: "prepared-message" } }));
        });
      });
      const request = vi.spyOn(http, "request");
      const sending = send(baseUrl).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await Promise.race([
          preparing.promise,
          arrived.promise.then(() => {
            throw new Error("QA POST bypassed preparation");
          }),
        ]);
        expect(request).not.toHaveBeenCalled();
        prepared.resolve();
        if (!refused) {
          await arrived.promise;
          response.resolve();
        }
        expect(await sending).toEqual(
          refused ? { error: refusal } : { value: { message: { id: "prepared-message" } } },
        );
        expect(request).toHaveBeenCalledTimes(refused ? 0 : 1);
      } finally {
        prepared.resolve();
        response.resolve();
        await sending;
      }
    },
  );

  it("rejects conflicting embedded and explicit thread ids", () => {
    expect(resolveQaTargetThread({ target: "thread:Room/Topic", threadId: "Topic" })).toEqual({
      target: {
        chatType: "channel",
        conversationId: "Room",
        threadId: "Topic",
      },
      threadId: "Topic",
    });
    expect(() => resolveQaTargetThread({ target: "thread:Room/Topic", threadId: "Other" })).toThrow(
      "qa-channel target conflicts with the explicit threadId",
    );
  });

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const baseUrl = await startJsonServer(() => ({ body: '{"cursor":1,"events":[' }));
    await expect(poll(baseUrl)).rejects.toThrow("qa-bus /v1/poll: malformed JSON response");
  });

  it.each([
    ["/v1/poll", poll, "qa-bus /v1/poll"],
    ["/v1/state", getQaBusState, "qa-channel.bus-state"],
  ] as const)("bounds oversized %s responses", async (path, read, label) => {
    const { baseUrl, closed } = await startOversizedServer(path);
    await expect(read(baseUrl)).rejects.toThrow(`${label}: JSON response exceeds 16777216 bytes`);
    if (read === poll) {
      expect(await closed).toBeLessThan(OVERSIZED_RESPONSE_BYTES);
    }
  });

  it("rejects immediately when a poll request is aborted", async () => {
    const baseUrl = await startServer(() => {});
    const abort = new AbortController();
    const request = poll(baseUrl, {
      timeoutMs: 30_000,
      signal: abort.signal,
    });
    abort.abort();

    const rejection = expect(withTimeout(request, 500, "poll abort did not settle")).rejects;
    await rejection.toBeInstanceOf(Error);
    await rejection.toMatchObject({ name: "AbortError" });
  });

  it.each([false, true])("bounds stalled messages after headers=%s", async (headers) => {
    const stalled = createDeferred<void>();
    const baseUrl = await startServer((_req, res) => {
      if (headers) {
        res.writeHead(200, { "content-type": "application/json", "content-length": "128" });
        res.write('{"message":', () => stalled.resolve());
      } else {
        stalled.resolve();
      }
    });
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    const request = send(baseUrl);
    const rejection = expect(
      withTimeout(request, 1_000, "stalled response body did not settle"),
    ).rejects.toMatchObject({ name: "AbortError", cause: { name: "TimeoutError" } });

    await withTimeout(stalled.promise, 500, "server did not reach the stalled phase");
    timeout.abort(new DOMException("qa-bus request timed out", "TimeoutError"));
    await rejection;
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("keeps long polls within the server wait window plus response grace", async () => {
    const server = await startJsonServer(() => ({
      body: JSON.stringify({ cursor: 1, events: [] }),
    }));
    stops.push(server["stop"]);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await expect(
      pollQaBus({
        baseUrl: server.baseUrl,
        accountId: "acct-a",
        cursor: 0,
        acknowledgedCursor: 0,
        timeoutMs: 30_000,
      }),
    ).resolves.toEqual({ cursor: 1, events: [] });
    expect(timeoutSpy).toHaveBeenCalledWith(40_000);
  });

  it("preserves baseUrl path prefixes when composing bus URLs", async () => {
    const state = { cursor: 1, conversations: [], threads: [], messages: [], events: [] };
    const baseUrl = await startJsonServer((req) => ({
      statusCode: req.url === "/qa-bus/v1/state" ? 200 : 404,
      body:
        req.url === "/qa-bus/v1/state"
          ? JSON.stringify(state)
          : JSON.stringify({ error: `unexpected path: ${req.url}` }),
    }));

    await expect(getQaBusState(`${baseUrl}/qa-bus`)).resolves.toEqual(state);
    expect(guardedFetchCalls.at(-1)).toMatchObject({
      auditContext: "qa-channel.bus-state",
      timeoutMs: 10_000,
    });
  });
});
