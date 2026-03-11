import { describe, expect, it } from "vitest";
import { isGatewayAgentDeliveryConfirmed } from "./subagent-announce.js";

describe("isGatewayAgentDeliveryConfirmed", () => {
  it("returns false when gateway agent result has no delivery confirmation", () => {
    expect(
      isGatewayAgentDeliveryConfirmed({
        status: "ok",
        result: {
          payloads: [{ text: "done" }],
        },
      }),
    ).toBe(false);
  });

  it("returns true when gateway agent result includes delivery metadata", () => {
    expect(
      isGatewayAgentDeliveryConfirmed({
        status: "ok",
        result: {
          payloads: [{ text: "done" }],
          delivery: {
            channel: "telegram",
            to: "123",
            via: "direct",
            messageId: "456",
            mediaUrl: null,
          },
        },
      }),
    ).toBe(true);
  });
});
