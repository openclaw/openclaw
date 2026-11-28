import { describe, expect, it } from "vitest";
import { resolveCompletionDeliveryOrigins } from "./subagent-announce-origin.js";

describe("resolveCompletionDeliveryOrigins", () => {
  it("drops a session key stored as the external target", () => {
    const stored = { channel: "telegram", to: "agent:main:build", threadId: "7" };
    const origins = resolveCompletionDeliveryOrigins({
      expectsCompletionMessage: true,
      directOrigin: stored,
      requesterSessionOrigin: stored,
      completionDirectOrigin: stored,
    });
    expect(origins.directOrigin).toEqual({ channel: "telegram" });
    expect(origins.requesterSessionOrigin).toEqual({ channel: "telegram" });
    expect(origins.effectiveDirectOrigin).toEqual({ channel: "telegram" });
  });

  it("keeps an internal route's own session key", () => {
    const origin = { channel: "webchat", to: "agent:main:build" };
    const origins = resolveCompletionDeliveryOrigins({
      expectsCompletionMessage: false,
      directOrigin: origin,
      requesterSessionOrigin: origin,
    });
    expect(origins.directOrigin).toEqual(origin);
    expect(origins.requesterSessionOrigin).toEqual(origin);
  });

  it("keeps a real chat target", () => {
    const origin = { channel: "telegram", to: "telegram:12345" };
    const origins = resolveCompletionDeliveryOrigins({
      expectsCompletionMessage: true,
      directOrigin: origin,
      requesterSessionOrigin: origin,
    });
    expect(origins.effectiveDirectOrigin).toEqual(origin);
  });
});
