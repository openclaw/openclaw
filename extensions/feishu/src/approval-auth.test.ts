import { describe, expect, it } from "vitest";
import { feishuApprovalAuth } from "./approval-auth.js";

describe("feishuApprovalAuth", () => {
  it("authorizes open_id approvers from allowFrom for backward compatibility", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: { channels: { feishu: { allowFrom: ["ou_owner"] } } },
        senderId: "ou_owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: { channels: { feishu: { allowFrom: ["user_123"] } } },
        senderId: "ou_attacker",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("uses approvalApprovers before allowFrom when configured", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          channels: {
            feishu: {
              allowFrom: ["ou_dm_user"],
              approvalApprovers: ["ou_approver"],
            },
          },
        },
        senderId: "ou_approver",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          channels: {
            feishu: {
              allowFrom: ["ou_dm_user"],
              approvalApprovers: ["ou_approver"],
            },
          },
        },
        senderId: "ou_dm_user",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on Feishu.",
    });
  });

  it("uses account-level approvalApprovers for named accounts", () => {
    expect(
      feishuApprovalAuth.authorizeActorAction({
        cfg: {
          channels: {
            feishu: {
              allowFrom: ["ou_top_level"],
              accounts: {
                work: {
                  allowFrom: ["ou_account_dm_user"],
                  approvalApprovers: ["ou_account_approver"],
                },
              },
            },
          },
        },
        accountId: "work",
        senderId: "ou_account_approver",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });
});
