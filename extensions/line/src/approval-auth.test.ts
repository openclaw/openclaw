// Line tests cover approval actor authorization against the account allowlist.
import { describe, expect, it } from "vitest";
import { getLineApprovalApprovers, lineApprovalAuth } from "./approval-auth.js";

describe("lineApprovalAuth", () => {
  const approver = `U${"a".repeat(32)}`;
  const other = `U${"b".repeat(32)}`;
  const groupId = `C${"a".repeat(32)}`;

  it("authorizes a configured approver written as a bare id or a LINE address", () => {
    for (const entry of [approver, `line:user:${approver}`, `line:${approver}`]) {
      expect(
        lineApprovalAuth.authorizeActorAction({
          cfg: { channels: { line: { allowFrom: [entry] } } },
          senderId: approver,
          action: "approve",
          approvalKind: "exec",
        }),
      ).toEqual({ authorized: true });
    }
  });

  it("denies a sender outside a configured approver set and names LINE", () => {
    expect(
      lineApprovalAuth.authorizeActorAction({
        cfg: { channels: { line: { allowFrom: [approver] } } },
        senderId: other,
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve plugin requests on LINE.",
    });
  });

  it("keeps implicit same-chat authorization when no allowlist entry is an approver", () => {
    // A group id addresses a conversation, so it yields no approver and the
    // account falls back to the same-chat `/approve` authorization it had before
    // this capability existed.
    const cfg = { channels: { line: { allowFrom: [groupId] } } };
    expect(getLineApprovalApprovers({ cfg })).toEqual([]);
    expect(
      lineApprovalAuth.authorizeActorAction({
        cfg,
        senderId: other,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("does not fold case, matching how LINE admits DM principals", () => {
    expect(
      lineApprovalAuth.authorizeActorAction({
        cfg: { channels: { line: { allowFrom: [approver] } } },
        senderId: `U${"A".repeat(32)}`,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on LINE.",
    });
  });

  it("resolves approvers for the addressed account only", () => {
    const cfg = {
      channels: {
        line: {
          allowFrom: [approver],
          accounts: { work: { allowFrom: [other] } },
        },
      },
    };
    expect(getLineApprovalApprovers({ cfg, accountId: "work" })).toEqual([other]);
  });
});
