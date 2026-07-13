// Telegram tests cover bounded Bot API response body helper behavior.
import { describe, expect, it, vi } from "vitest";
import { readTelegramResponseBodyWithTimeout } from "./response-body-timeout.js";

function makeOptions(overrides?: { maxBytes?: number; timeoutMs?: number }) {
  return {
    maxBytes: overrides?.maxBytes ?? 16,
    timeoutMs: overrides?.timeoutMs ?? 100,
    onIdleTimeout: ({ timeoutMs }: { timeoutMs: number }) => new Error(`idle ${timeoutMs}`),
    onDeadlineTimeout: ({ timeoutMs }: { timeoutMs: number }) => new Error(`deadline ${timeoutMs}`),
  };
}

describe("readTelegramResponseBodyWithTimeout", () => {
  it("cancels streamed response bodies when they exceed the byte cap", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel,
      }),
      { status: 200 },
    );

    await expect(
      readTelegramResponseBodyWithTimeout(response, makeOptions({ maxBytes: 2 })),
    ).rejects.toThrow("Content too large: 3 bytes (limit: 2 bytes)");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("fails and cancels getReader-less response bodies on the deadline", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(async () => undefined);
      const response = {
        body: { cancel },
        arrayBuffer: async () => await new Promise<ArrayBuffer>(() => {}),
      } as unknown as Response;

      const read = readTelegramResponseBodyWithTimeout(response, makeOptions({ timeoutMs: 50 }));
      const assertion = expect(read).rejects.toThrow("deadline 50");

      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});
