import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  wakeSessionForGeneratedMediaDirectDelivery,
} from "./generated-media-direct-delivery-wake.js";

afterEach(() => testing.setDepsForTest());

describe("wakeSessionForGeneratedMediaDirectDelivery", () => {
  it("continues the owning session after emergency direct delivery", () => {
    const enqueueSystemEvent = vi.fn(() => true);
    const requestHeartbeat = vi.fn();
    testing.setDepsForTest({ enqueueSystemEvent, requestHeartbeat });

    wakeSessionForGeneratedMediaDirectDelivery({
      sessionKey: "agent:main:discord:channel:123",
      mediaLabel: "image",
      status: "ok",
      deliveryContext: { channel: "discord", to: "channel:123" },
      contextKey: "image:task-1:emergency",
    });

    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining("durable agent-loop persistence was unavailable"),
      expect.objectContaining({
        sessionKey: "agent:main:discord:channel:123",
        contextKey: "image:task-1:emergency",
      }),
    );
    expect(requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "generated-media:direct-delivery-emergency" }),
    );
  });

  it("never throws when the emergency wake cannot be queued", () => {
    testing.setDepsForTest({
      enqueueSystemEvent: vi.fn(() => {
        throw new Error("queue unavailable");
      }),
    });

    expect(() =>
      wakeSessionForGeneratedMediaDirectDelivery({
        sessionKey: "agent:main:main",
        mediaLabel: "media",
        status: "ok",
        contextKey: "media:task-1:emergency",
      }),
    ).not.toThrow();
  });
});
