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
    expect(origins.directOrigin?.to).toBeUndefined();
    expect(origins.requesterSessionOrigin?.to).toBeUndefined();
    expect(origins.effectiveDirectOrigin?.to).toBeUndefined();
    expect(origins.effectiveDirectOrigin?.threadId).toBeUndefined();
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
