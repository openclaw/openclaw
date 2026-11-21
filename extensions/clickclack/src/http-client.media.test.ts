import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { describe, expect, it, vi } from "vitest";
import { ClickClackHttpError, createClickClackClient } from "./http-client.js";

const effectGate = vi.hoisted((): { prepare: (() => Promise<void>) | undefined } => ({
  prepare: undefined,
}));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

function createTestClient(fetch: typeof globalThis.fetch) {
  return createClickClackClient({ baseUrl: "https://clickclack.example", token: "fake", fetch });
}

describe("ClickClack HTTP client", () => {
  it.each([
    { status: 404, callerCancelled: false },
    { status: 503, callerCancelled: false },
    { status: 200, callerCancelled: false },
    { status: 404, callerCancelled: true },
  ])(
    "bounds a slow upload body (status=$status, callerCancelled=$callerCancelled)",
    async ({ status, callerCancelled }) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const callerFailure = new Error("upload caller stopped");
      const receivedHeaders = createDeferred<AbortSignal>();
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("missing upload request cancellation");
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            controller.enqueue(new Uint8Array([1]));
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        receivedHeaders.resolve(signal);
        return new Response(stream, { status, headers: { "Retry-After": "17" } });
      });
      const consume = vi.fn(async (response: Response) => [
        ...new Uint8Array(await response.arrayBuffer()),
      ]);
      const request = createTestClient(fetchMock).consumeUpload("upl_slow", consume, caller.signal);
      const sending = request.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let signal: AbortSignal | undefined;
      try {
        signal = await receivedHeaders.promise;
        // Every chunk arrives before the shared error-reader's ten-second idle
        // guard, so only the upload's total deadline can stop this slow response.
        for (const byte of [2, 3, 4]) {
          await vi.advanceTimersByTimeAsync(9_000);
          body?.enqueue(new Uint8Array([byte]));
        }
        if (callerCancelled) {
          caller.abort(callerFailure);
        }
        await vi.advanceTimersByTimeAsync(3_000);
        expect(signal.aborted).toBe(status !== 200);
        if (status === 200) {
          body?.close();
          expect(await sending).toEqual({ value: [1, 2, 3, 4] });
        } else if (callerCancelled) {
          expect(await sending).toEqual({ error: callerFailure });
        } else {
          const result = await sending;
          if (!("error" in result) || !(result.error instanceof ClickClackHttpError)) {
            throw new Error("expected the observed ClickClack HTTP rejection");
          }
          expect(result.error.status).toBe(status);
          expect(result.error.message).toBe(
            `ClickClack ${status}: upload error details unavailable`,
          );
          expect(result.error.headers.get("Retry-After")).toBe("17");
        }
        expect(consume).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
      } finally {
        if (!signal?.aborted) {
          body?.close();
        }
        await sending;
        vi.useRealTimers();
      }
    },
  );
});

it.each([
  { kind: "message", retired: false },
  { kind: "message", retired: true },
  { kind: "upload", retired: false },
  { kind: "upload", retired: true },
] as const)(
  "rechecks the $kind caller after effect preparation (retired=$retired)",
  async ({ kind, retired }) => {
    const preparing = createDeferred();
    const prepared = createDeferred();
    const dispatched = createDeferred();
    const response = createDeferred<Response>();
    const caller = new AbortController();
    const failure = new Error("ClickClack caller retired");
    effectGate.prepare = async () => {
      preparing.resolve();
      await prepared.promise;
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() => {
      dispatched.resolve();
      return response.promise;
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch,
      beforeRequest: () => caller.signal.throwIfAborted(),
    });
    const createResponse = () =>
      kind === "message"
        ? Response.json({ message: { id: "msg_1" } })
        : new Response(new Uint8Array([1, 2, 3]));
    const request =
      kind === "message"
        ? client.createChannelMessage("chn_1", "hello")
        : client.consumeUpload("upl_1", async (uploadResponse) => [
            ...new Uint8Array(await uploadResponse.arrayBuffer()),
          ]);
    const sending = request.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        preparing.promise,
        dispatched.promise.then(() => {
          throw new Error("dispatched before preparation");
        }),
      ]);
      expect(fetch).not.toHaveBeenCalled();
      if (retired) {
        caller.abort(failure);
      }
      prepared.resolve();
      if (!retired) {
        await dispatched.promise;
        caller.abort(failure);
      }
      response.resolve(createResponse());
      expect(await sending).toEqual(
        retired ? { error: failure } : { value: kind === "message" ? { id: "msg_1" } : [1, 2, 3] },
      );
      expect(fetch).toHaveBeenCalledTimes(retired ? 0 : 1);
    } finally {
      prepared.resolve();
      response.resolve(createResponse());
      await sending;
      effectGate.prepare = undefined;
    }
  },
);
