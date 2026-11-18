import http, { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQaBusState, pollQaBus, sendQaBusMessage } from "./bus-client.js";
import { jsonServer as json, serve } from "./http.test-support.js";

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

function createOversizedJsonServer(pathname: string): { server: Server; closed: Promise<number> } {
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<number>();
  const server = createServer((req, res) => {
    if (req.url !== pathname) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `unexpected path: ${req.url}` }));
      return;
    }
    let sentBytes = 0;
    const prefix = Buffer.from('{"payload":"');
    const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
    const suffix = Buffer.from('"}');
    const body = Readable.from(
      (function* () {
        sentBytes += prefix.length;
        yield prefix;
        while (sentBytes + bodyChunk.length + suffix.length < OVERSIZED_RESPONSE_BYTES) {
          sentBytes += bodyChunk.length;
          yield bodyChunk;
        }
        sentBytes += suffix.length;
        yield suffix;
      })(),
    );
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.on("close", () => {
      body.destroy();
      resolveClosed(sentBytes);
    });
    req.on("aborted", () => {
      res.destroy();
    });
    body.pipe(res);
  });
  return { server, closed };
}

describe("qa-bus client", () => {
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
      timeoutMs: 0,
      ...overrides,
    });
  }

  afterEach(() => {
    guardedFetchCalls.length = 0;
    vi.restoreAllMocks();
  });

  it.for(["current", "aborted", "revoked", "refresh-failed"] as const)(
    "fences the native request after dispatch bookkeeping: %s",
    async (state, { signal }) => {
      let accepted = 0;
      const baseUrl = await json(() => {
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
    const server = createServer((req) => {
      accepted++;
      req.destroy();
    });
    const baseUrl = await serve(server);
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
      const server = createServer((_req, res) => {
        arrived.resolve();
        void response.promise.then(() => {
          res.end(JSON.stringify({ message: { id: "prepared-message" } }));
        });
      });
      const baseUrl = await serve(server);
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

  it("rejects malformed JSON responses instead of throwing from the stream callback", async () => {
    const baseUrl = await json(() => ({
      body: '{"cursor":1,"events":[',
    }));
    await expect(poll(baseUrl)).rejects.toThrow("qa-bus /v1/poll: malformed JSON response");
  });

  it("bounds oversized poll responses and closes the stream early", async () => {
    const oversized = createOversizedJsonServer("/v1/poll");
    const baseUrl = await serve(oversized.server);
    await expect(poll(baseUrl)).rejects.toThrow(
      "qa-bus /v1/poll: JSON response exceeds 16777216 bytes",
    );
    const sentBytes = await oversized.closed;
    expect(sentBytes).toBeLessThan(OVERSIZED_RESPONSE_BYTES);
  });

  it("rejects immediately when a poll request is aborted", async () => {
    const server = createServer((_req, _res) => {
      // Keep the request open so the client abort path owns the outcome.
    });

    const baseUrl = await serve(server);
    const abort = new AbortController();
    const request = poll(baseUrl, { timeoutMs: 30_000, signal: abort.signal });
    abort.abort();

    try {
      await withTimeout(request, 500, { message: "poll abort did not settle" });
      throw new Error("expected poll abort to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe("AbortError");
    }
  });

  it("bounds stalled message requests with a total deadline", async () => {
    const server = createServer((_req, _res) => {
      // Accept the request without returning headers so the client deadline owns the outcome.
    });
    const baseUrl = await serve(server);

    const realAbortSignalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementationOnce(() => realAbortSignalTimeout(25));

    await expect(send(baseUrl)).rejects.toMatchObject({
      name: "AbortError",
      cause: { name: "TimeoutError" },
    });
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("bounds message responses that stall after headers", async () => {
    const { promise: bodyStarted, resolve: markBodyStarted } = Promise.withResolvers<void>();
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": "128",
      });
      res.write('{"message":', () => markBodyStarted());
    });
    const baseUrl = await serve(server);

    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    const request = send(baseUrl);
    const rejection = expect(
      withTimeout(request, 1_000, { message: "stalled response body did not settle" }),
    ).rejects.toMatchObject({ name: "AbortError", cause: { name: "TimeoutError" } });

    await withTimeout(bodyStarted, 500, { message: "server did not start the response body" });
    timeout.abort(new DOMException("qa-bus request timed out", "TimeoutError"));
    await rejection;
    expect(timeoutSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
  });

  it("keeps long polls within the server wait window plus response grace", async () => {
    const baseUrl = await json(() => ({
      body: JSON.stringify({ cursor: 1, events: [] }),
    }));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await expect(poll(baseUrl, { timeoutMs: 30_000 })).resolves.toEqual({ cursor: 1, events: [] });
    expect(timeoutSpy).toHaveBeenCalledWith(40_000);
  });

  it("preserves baseUrl path prefixes when composing bus URLs", async () => {
    const snapshot = { cursor: 1, conversations: [], threads: [], messages: [], events: [] };
    const baseUrl = await json((req) => ({
      statusCode: req.url === "/qa-bus/v1/state" ? 200 : 404,
      body:
        req.url === "/qa-bus/v1/state"
          ? JSON.stringify(snapshot)
          : JSON.stringify({ error: `unexpected path: ${req.url}` }),
    }));
    await expect(getQaBusState(`${baseUrl}/qa-bus`)).resolves.toEqual(snapshot);
    expect(guardedFetchCalls.at(-1)).toMatchObject({
      auditContext: "qa-channel.bus-state",
      timeoutMs: 10_000,
    });
  });

  it("bounds oversized qa-bus state responses", async () => {
    const oversized = createOversizedJsonServer("/v1/state");
    const baseUrl = await serve(oversized.server);
    await expect(getQaBusState(baseUrl)).rejects.toThrow(
      "qa-channel.bus-state: JSON response exceeds 16777216 bytes",
    );
  });
});
