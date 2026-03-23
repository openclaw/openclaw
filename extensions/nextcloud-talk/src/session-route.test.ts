import { describe, expect, it } from "vitest";
import { resolveNextcloudTalkOutboundSessionRoute } from "./session-route.js";

describe("nextcloud talk session route", () => {
  it("builds an outbound session route for normalized room targets", () => {
    const route = resolveNextcloudTalkOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "nextcloud-talk:room-123",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "group",
        id: "room-123",
      },
      from: "nextcloud-talk:room:room-123",
      to: "nextcloud-talk:room-123",
    });
  });

  it("returns null when the target cannot be normalized to a room id", () => {
    expect(
      resolveNextcloudTalkOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "",
      }),
    ).toBeNull();
  });
});
