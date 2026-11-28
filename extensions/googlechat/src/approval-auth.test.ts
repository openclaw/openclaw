// Googlechat tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { googleChatApprovalAuth, resolveGoogleChatDirectTarget } from "./approval-auth.js";

describe("googleChatApprovalAuth", () => {
  it("authorizes stable users/* ids and ignores email-style approvers", () => {
    expect(
      googleChatApprovalAuth.authorizeActorAction({
        cfg: { channels: { googlechat: { allowFrom: ["users/123"] } } },
        senderId: "users/123",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      googleChatApprovalAuth.authorizeActorAction({
        cfg: { channels: { googlechat: { allowFrom: ["owner@example.com"] } } },
        senderId: "users/attacker",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});

describe("resolveGoogleChatDirectTarget", () => {
  it("maps numeric user names and skips email and space names", () => {
    expect(resolveGoogleChatDirectTarget({ senderId: "users/12345" })).toEqual({
      kind: "direct",
      to: "users/12345",
    });
    expect(resolveGoogleChatDirectTarget({ senderId: "users/owner@example.com" })).toBeUndefined();
    expect(resolveGoogleChatDirectTarget({ senderId: "spaces/AAA" })).toBeUndefined();
  });
});
