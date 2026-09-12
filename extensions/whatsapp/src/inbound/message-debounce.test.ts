import { afterEach, describe, expect, it, vi } from "vitest";
import { createWhatsAppInboundMessageDebouncer } from "./message-debounce.js";
import { createTestWebInboundMessage } from "./test-message.test-helper.js";
import type { AdmittedWebInboundCallbackMessage } from "./types.js";

describe("WhatsApp inbound message debounce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves rapid images and following text as one ordered turn", async () => {
    vi.useFakeTimers();
    const delivered: AdmittedWebInboundCallbackMessage[] = [];
    const onMessage = vi.fn(async (message: AdmittedWebInboundCallbackMessage) => {
      delivered.push(message);
    });
    const markRead = vi.fn(async () => undefined);
    const debouncer = createWhatsAppInboundMessageDebouncer({
      resolveDebounceMs: () => 100,
      onMessage,
      shouldDebounce: () => true,
      markRead,
      onPendingWorkChanged: () => undefined,
      onError: (error) => {
        throw error;
      },
    });

    await debouncer.enqueue(
      createTestWebInboundMessage({
        event: { id: "image-1", timestamp: 1 },
        payload: {
          body: "first caption",
          media: { path: "/tmp/first.jpg", type: "image/jpeg", kind: "image" },
        },
      }),
    );
    await debouncer.enqueue(
      createTestWebInboundMessage({
        event: { id: "image-2", timestamp: 2 },
        payload: {
          body: "",
          media: { path: "/tmp/second.png", type: "image/png", kind: "image" },
        },
      }),
    );
    await debouncer.enqueue(
      createTestWebInboundMessage({
        event: { id: "text-3", timestamp: 3 },
        payload: { body: "compare these" },
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    await debouncer.drain();

    expect(onMessage).toHaveBeenCalledTimes(1);
    const combined = delivered[0];
    expect(combined?.payload.body).toBe("first caption\ncompare these");
    expect(combined?.payload.media).toEqual({
      path: "/tmp/first.jpg",
      type: "image/jpeg",
      kind: "image",
    });
    expect(combined?.payload.mediaItems).toEqual([
      { path: "/tmp/first.jpg", type: "image/jpeg", kind: "image" },
      { path: "/tmp/second.png", type: "image/png", kind: "image" },
    ]);
    expect(combined?.event).toMatchObject({ id: "text-3", isBatched: true });
  });
});
