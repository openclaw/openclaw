// Voice Call tests cover shared provider response-body idle bounds.
import { describe, expect, it, vi } from "vitest";
import { readProviderJsonResponseText } from "./response-body.js";

describe("readProviderJsonResponseText idle timeout", () => {
  it("times out when a provider JSON response body stalls after headers", async () => {
    vi.useFakeTimers();
    try {
      const pending = readProviderJsonResponseText(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"sid":'));
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      const settled = expect(pending).rejects.toThrow(
        "provider response body stalled: no data received for 30000ms",
      );
      await vi.advanceTimersByTimeAsync(30_060);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
