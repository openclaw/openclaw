import { describe, expect, it } from "vitest";
import { slackApprovalAuth } from "./approval-auth.js";

describe("slackApprovalAuth", () => {
  it("authorizes inferred Slack approvers by user id", () => {
    const cfg = { channels: { slack: { allowFrom: ["U_OWNER"] } } };

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U_OWNER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U_ATTACKER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Slack.",
    });
  });
});
