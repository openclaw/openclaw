// Nextcloud Talk tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";

describe("nextcloudTalkApprovalAuth", () => {
  it("matches Nextcloud Talk actor ids case-insensitively", () => {
    const cfg = { channels: { "nextcloud-talk": { allowFrom: ["Owner"] } } };
    const approvalCapability = nextcloudTalkPlugin.approvalCapability;
    if (!approvalCapability?.authorizeActorAction) {
      throw new Error("Nextcloud Talk approval authorization unavailable");
    }

    expect(
      approvalCapability.authorizeActorAction({
        cfg,
        senderId: "owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
