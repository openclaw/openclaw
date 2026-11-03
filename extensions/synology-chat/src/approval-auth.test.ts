// Synology Chat tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { synologyChatPlugin } from "./channel.js";

describe("synologyChatApprovalAuth", () => {
  it("authorizes numeric Synology Chat user ids", () => {
    const cfg = { channels: { "synology-chat": { allowedUserIds: ["123"] } } };
    const approvalCapability = synologyChatPlugin.approvalCapability;
    if (!approvalCapability?.authorizeActorAction) {
      throw new Error("Synology Chat approval authorization unavailable");
    }

    expect(
      approvalCapability.authorizeActorAction({
        cfg,
        senderId: "123",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });
});
