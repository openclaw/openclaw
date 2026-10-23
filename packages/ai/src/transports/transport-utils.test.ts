import { afterEach, describe, expect, it, vi } from "vitest";
import { readAnthropicMessagesErrorSnippet } from "./transport-utils.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Anthropic Messages error snippet cancellation", () => {
  it.each(["byte limit", "idle timeout"] as const)(
    "settles the %s outcome without waiting for response cancellation",
    async (boundary) => {
      vi.useFakeTimers();
      const cancellation = Promise.withResolvers<void>();
      const timeoutError = new Error(
        "Anthropic Messages error response stalled: no data received for 10000ms",
      );
      let cancelStarted = false;
      let cancelReason: unknown;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (boundary === "byte limit") {
            controller.enqueue(new TextEncoder().encode("a".repeat(8194)));
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
      const pending = readAnthropicMessagesErrorSnippet(response).then(
        (value) => {
          outcome = { value };
        },
        (error: unknown) => {
          outcome = { error };
        },
      );

      try {
        await vi.advanceTimersByTimeAsync(boundary === "idle timeout" ? 10_000 : 0);
        expect(outcome).toEqual(
          boundary === "byte limit" ? { value: `${"a".repeat(8192)}…` } : { error: timeoutError },
        );
        expect(cancelStarted).toBe(true);
        expect(response.body?.locked).toBe(false);
        if (boundary === "idle timeout") {
          expect(cancelReason).toBe(outcome?.error);
        }
      } finally {
        // Drain the fixture even on the baseline, whose observation still awaits cancellation.
        cancellation.resolve();
        await pending;
      }
    },
  );
});
