// Nextcloud Talk tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";

describe("nextcloudTalkApprovalAuth", () => {
  it("matches Nextcloud Talk actor ids case-insensitively", () => {
    const cfg = { channels: { "nextcloud-talk": { allowFrom: ["Owner"] } } };

    expect(
      nextcloudTalkApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("matches Talk users/ actor ids against bare allowlisted user ids", () => {
    const authorize = (senderId: string, allowFrom = ["owner"]) =>
      nextcloudTalkApprovalAuth.authorizeActorAction({
        cfg: { channels: { "nextcloud-talk": { allowFrom } } },
        senderId,
        action: "approve",
        approvalKind: "exec",
      }).authorized;

    expect(authorize("users/owner")).toBe(true);
    expect(authorize("guests/owner")).toBe(false);
    expect(authorize("users/owner", ["other-approver"])).toBe(false);
  });
});
