import { describe, expect, it } from "vitest";
import { getIMessageApprovalApprovers, imessageApprovalAuth } from "./approval-auth.js";

describe("imessageApprovalAuth", () => {
  it("authorizes individual handles and ignores group/chat target entries", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["+1 (555) 123-0000"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      getIMessageApprovalApprovers({
        cfg: {
          channels: {
            imessage: {
              allowFrom: ["chat_guid:iMessage;+;chat123", "chat_id:42"],
            },
          },
        },
      }),
    ).toEqual([]);

    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["+15551230000"] } } },
        senderId: "+15551239999",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on iMessage.",
    });
  });

  it("authorizes lowercase-normalized email senders against canonical allowFrom", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["Owner@Example.com"] } } },
        senderId: "owner@example.com",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("falls back to implicit same-chat authorization when no allowFrom is configured", () => {
    expect(
      getIMessageApprovalApprovers({
        cfg: { channels: { imessage: { allowFrom: [] } } },
      }),
    ).toEqual([]);

    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: [] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("supports explicit wildcard approval approvers", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["*"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("strips imessage:/sms:/auto: service prefixes when matching senders", () => {
    expect(
      imessageApprovalAuth.authorizeActorAction({
        cfg: { channels: { imessage: { allowFrom: ["imessage:+15551230000"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});
