import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQaFixtureJson } from "./fixture-utils.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fetchQaFixtureJson", () => {
  it("aborts requests that never resolve", async () => {
    let signal: AbortSignal | undefined;
    const result = expect(
      fetchQaFixtureJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async (_url, init) => {
          signal = init.signal as AbortSignal | undefined;
          return new Promise<Response>(() => {});
        },
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/debug/requests timed out after 25ms",
    });
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(signal?.aborted).toBe(true);
  });

  it("times out while reading stalled response bodies", async () => {
    const result = expect(
      fetchQaFixtureJson("https://qa.example.invalid/v1/responses", undefined, {
        timeoutMs: 25,
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "HTTP request to https://qa.example.invalid/v1/responses timed out after 25ms",
    });
    await vi.advanceTimersByTimeAsync(25);
    await result;
  });

  it("parses successful JSON responses", async () => {
    await expect(
      fetchQaFixtureJson("https://qa.example.invalid/debug/requests", undefined, {
        timeoutMs: 25,
        fetchImpl: async () => new Response('{"ok":true}', { status: 200 }),
      }),
    ).resolves.toEqual({ ok: true });
  });

  it("bounds oversized response bodies", async () => {
    await expect(
      fetchQaFixtureJson("https://qa.example.invalid/debug/requests", undefined, {
        maxBodyBytes: 16,
        timeoutMs: 1000,
        fetchImpl: async () =>
          new Response(JSON.stringify({ ok: true, padding: "x".repeat(128) }), {
            status: 200,
          }),
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "HTTP response from https://qa.example.invalid/debug/requests exceeded 16 bytes",
    });
  });

  it.each(["advertised", "streamed"] as const)(
    "reports %s overflow without waiting for response cancellation",
    async (kind) => {
      const cancellation = Promise.withResolvers<void>();
      const cancel = vi.fn(() => cancellation.promise);
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(17));
          },
          cancel,
        }),
        { headers: kind === "advertised" ? { "content-length": "17" } : undefined },
      );
      const outcome = fetchQaFixtureJson("https://qa.example.invalid/debug/requests", undefined, {
        maxBodyBytes: 16,
        timeoutMs: 25,
        fetchImpl: async () => response,
      }).catch((error: unknown) => error);
      try {
        await vi.advanceTimersByTimeAsync(25);
        expect(
          await Promise.race([outcome, Promise.resolve("waiting for cancellation")]),
        ).toMatchObject({
          code: "ETOOBIG",
          message: "HTTP response from https://qa.example.invalid/debug/requests exceeded 16 bytes",
        });
        expect(cancel).toHaveBeenCalledOnce();
      } finally {
        cancellation.resolve();
        await outcome;
      }
    },
  );
});
