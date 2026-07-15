// Covers the system-event + heartbeat wake queued after a generated-media
// direct-delivery fallback bypasses the requester's agent turn.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  wakeSessionForGeneratedMediaDirectDelivery,
} from "./generated-media-direct-delivery-wake.js";

afterEach(() => {
  testing.setDepsForTest();
});

function createWakeSpies() {
  const enqueueSystemEvent = vi.fn(() => true);
  const requestHeartbeat = vi.fn();
  testing.setDepsForTest({ enqueueSystemEvent, requestHeartbeat });
  return { enqueueSystemEvent, requestHeartbeat };
}

describe("wakeSessionForGeneratedMediaDirectDelivery", () => {
  it("queues a system event and heartbeat wake for the owning session", () => {
    const { enqueueSystemEvent, requestHeartbeat } = createWakeSpies();

    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:discord:channel:123",
      mediaLabel: "image",
      status: "ok",
      deliveryContext: { channel: "discord", to: "channel:123", accountId: "acct-1" },
      contextKey: "image_generate:task-1:ok:direct",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    const [text, options] = enqueueSystemEvent.mock.calls[0] as unknown as [
      string,
      { sessionKey: string; contextKey?: string; deliveryContext?: Record<string, unknown> },
    ];
    expect(text).toContain("image generation task completed");
    expect(text).toContain("already delivered directly to the chat");
    expect(text).toContain("Do not resend the attachment");
    expect(options.sessionKey).toBe("agent:main:discord:channel:123");
    expect(options.contextKey).toBe("image_generate:task-1:ok:direct");
    expect(options.deliveryContext).toMatchObject({ channel: "discord", to: "channel:123" });

    expect(requestHeartbeat).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "background-task",
        intent: "event",
        reason: "generated-media:direct-delivery",
        coalesceMs: 0,
      }),
    );
  });

  it("uses failure wording for error completions", () => {
    const { enqueueSystemEvent, requestHeartbeat } = createWakeSpies();

    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:discord:channel:123",
      mediaLabel: "video",
      status: "error",
    });

    const [text] = enqueueSystemEvent.mock.calls[0] as unknown as [string];
    expect(text).toContain("video generation task failed");
    expect(text).toContain("failure notice was already delivered directly");
    expect(requestHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("defaults the media label when none is provided", () => {
    const { enqueueSystemEvent } = createWakeSpies();

    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:discord:channel:123",
    });

    const [text] = enqueueSystemEvent.mock.calls[0] as unknown as [string];
    expect(text).toContain("background media generation task completed");
  });

  it("skips the heartbeat wake for subagent requester sessions", () => {
    const { enqueueSystemEvent, requestHeartbeat } = createWakeSpies();

    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:subagent:11111111-2222-3333-4444-555555555555",
      mediaLabel: "music",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("does nothing for empty session keys", () => {
    const { enqueueSystemEvent, requestHeartbeat } = createWakeSpies();

    wakeSessionForGeneratedMediaDirectDelivery({ sessionKey: "   " });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });

  it("never throws when the wake deps fail", () => {
    const requestHeartbeat = vi.fn();
    testing.setDepsForTest({
      enqueueSystemEvent: vi.fn(() => {
        throw new Error("queue unavailable");
      }),
      requestHeartbeat,
    });

    expect(() =>
      wakeSessionForGeneratedMediaDirectDelivery({
        sessionKey: "agent:main:discord:channel:123",
      }),
    ).not.toThrow();
    expect(requestHeartbeat).not.toHaveBeenCalled();
  });
});
