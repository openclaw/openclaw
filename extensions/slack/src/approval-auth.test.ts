import { describe, expect, it } from "vitest";
import { slackApprovalAuth } from "./approval-auth.js";

describe("slackApprovalAuth", () => {
  it("authorizes inferred Slack approvers by user id", () => {
    const cfg = {
      channels: {
        slack: {
          execApprovals: { enabled: true, approvers: ["user:U123OWNER"] },
        },
      },
    };

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U123OWNER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      slackApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "U999ATTACKER",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Slack.",
    });
  });
});
