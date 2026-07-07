import { describe, expect, it } from "vitest";
import { imessagePlugin } from "./channel.js";

describe("iMessage outbound session routing", () => {
  it.each([
    ["+15551234567", true],
    ["chat_id:42", false],
    ["chat_guid:iMessage;+;chat123", false],
    ["chat_identifier:team-thread", false],
  ] as const)("reports canonical identity for %s", async (target, exact) => {
    const route = await imessagePlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target,
    });

    expect(route?.recipientSessionExact).toBe(exact);
  });
});
