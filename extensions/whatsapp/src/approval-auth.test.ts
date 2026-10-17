// Whatsapp tests cover approval auth plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  getWhatsAppApprovalApprovers,
  hasExplicitWhatsAppApprovers,
  whatsappApprovalAuth,
} from "./approval-auth.js";

describe("whatsappApprovalAuth", () => {
  it("authorizes direct WhatsApp recipients and ignores group entries", () => {
    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["+1 (555) 123-0000"] } } },
        senderId: "15551230000@s.whatsapp.net",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });

    expect(
      getWhatsAppApprovalApprovers({
        cfg: { channels: { whatsapp: { allowFrom: ["12345-67890@g.us"] } } },
      }),
    ).toEqual([]);

    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["+15551230000"] } } },
        senderId: "+15551239999",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({
      authorized: false,
      reason: "❌ You are not authorized to approve exec requests on WhatsApp.",
    });
  });

  it("does not treat defaultTo as an explicit approval approver", () => {
    expect(
      getWhatsAppApprovalApprovers({
        cfg: { channels: { whatsapp: { allowFrom: [], defaultTo: "+15551230000" } } },
      }),
    ).toEqual([]);

    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: [], defaultTo: "+15551230000" } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });

  it("supports explicit wildcard approval approvers", () => {
    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg: { channels: { whatsapp: { allowFrom: ["*"] } } },
        senderId: "+15551230000",
        action: "approve",
        approvalKind: "plugin",
      }),
    ).toEqual({ authorized: true });
  });

  it("lets execApprovals.approvers name the approvers separately from allowFrom", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15551230000", "+15559990000"],
          execApprovals: { approvers: ["+1 (555) 123-0000"] },
        },
      },
    };

    expect(getWhatsAppApprovalApprovers({ cfg })).toEqual(["+15551230000"]);
    expect(hasExplicitWhatsAppApprovers({ cfg })).toBe(true);
    expect(
      whatsappApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "15551230000@s.whatsapp.net",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
    // Still on allowFrom (may message the agent), but no longer an approver.
    for (const approvalKind of ["exec", "plugin"] as const) {
      expect(
        whatsappApprovalAuth.authorizeActorAction({
          cfg,
          senderId: "+15559990000",
          action: "approve",
          approvalKind,
        }),
      ).toEqual({
        authorized: false,
        reason: `❌ You are not authorized to approve ${approvalKind} requests on WhatsApp.`,
      });
    }
  });

  it("falls back to allowFrom when execApprovals.approvers is unset or empty", () => {
    for (const execApprovals of [undefined, {}, { approvers: [] }]) {
      const cfg = { channels: { whatsapp: { allowFrom: ["+15559990000"], execApprovals } } };
      expect(getWhatsAppApprovalApprovers({ cfg })).toEqual(["+15559990000"]);
      expect(hasExplicitWhatsAppApprovers({ cfg })).toBe(false);
    }
  });

  it("denies everyone when execApprovals.approvers names no usable number", () => {
    // A configured list that normalizes to nothing must not fall through to the implicit
    // same-chat authorization that an empty approver set means (pairing admits other senders).
    for (const approvers of [[""], ["not-a-number"], ["120363401234567890@g.us"]]) {
      const cfg: OpenClawConfig = {
        channels: {
          whatsapp: {
            dmPolicy: "pairing",
            allowFrom: ["+15551230000"],
            execApprovals: { approvers },
          },
        },
      };
      expect(getWhatsAppApprovalApprovers({ cfg })).toEqual([]);
      for (const senderId of ["+15559990000", "+15551230000"]) {
        for (const approvalKind of ["exec", "plugin"] as const) {
          expect(
            whatsappApprovalAuth.authorizeActorAction({
              cfg,
              senderId,
              action: "approve",
              approvalKind,
            }),
          ).toEqual({
            authorized: false,
            reason: `❌ You are not authorized to approve ${approvalKind} requests on WhatsApp.`,
          });
        }
      }
    }
  });

  it("reads execApprovals.approvers per account", () => {
    const cfg = {
      channels: {
        whatsapp: {
          allowFrom: ["+15559990000"],
          accounts: {
            work: {
              allowFrom: ["+15551230000", "+15559990000"],
              execApprovals: { approvers: ["+15551230000"] },
            },
          },
        },
      },
    };

    expect(getWhatsAppApprovalApprovers({ cfg, accountId: "work" })).toEqual(["+15551230000"]);
    expect(getWhatsAppApprovalApprovers({ cfg, accountId: "default" })).toEqual(["+15559990000"]);
  });
});
