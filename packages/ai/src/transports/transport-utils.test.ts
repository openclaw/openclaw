import { afterEach, describe, expect, it, vi } from "vitest";
import { readResponseTextSnippet } from "./transport-utils.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("readResponseTextSnippet cancellation", () => {
  it.each(["byte limit", "idle timeout"] as const)(
    "settles the %s outcome without waiting for response cancellation",
    async (boundary) => {
      vi.useFakeTimers();
      const cancellation = Promise.withResolvers<void>();
      const timeoutError = new Error("provider error body stalled");
      let cancelStarted = false;
      let cancelReason: unknown;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (boundary === "byte limit") {
            controller.enqueue(new TextEncoder().encode("abcdef"));
          }
        },
        cancel(reason) {
          cancelStarted = true;
          cancelReason = reason;
          return cancellation.promise;
        },
      });
      const response = new Response(body);
      let outcome: { value?: string; error?: unknown } | undefined;
      const pending = readResponseTextSnippet(response, {
        maxBytes: 4,
        chunkTimeoutMs: 10,
        onIdleTimeout: () => timeoutError,
      }).then(
        (value) => {
          outcome = { value };
        },
        (error: unknown) => {
          outcome = { error };
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(boundary === "idle timeout" ? 10 : 0);
        expect(outcome).toEqual(
          boundary === "byte limit" ? { value: "abcd…" } : { error: timeoutError },
        );
        expect(cancelStarted).toBe(true);
        expect(response.body?.locked).toBe(false);
        if (boundary === "idle timeout") {
          expect(cancelReason).toBe(timeoutError);
        }
      } finally {
        // Drain the fixture even on the baseline, whose observation still awaits cancellation.
        cancellation.resolve();
        await pending;
      }
    },
  );
});
