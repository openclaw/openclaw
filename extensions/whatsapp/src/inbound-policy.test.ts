import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppConversationGroupAllowFrom,
  resolveWhatsAppInboundPolicy,
} from "./inbound-policy.js";

function buildPolicyForCfg(cfg: OpenClawConfig) {
  return resolveWhatsAppInboundPolicy({ cfg, accountId: null, selfE164: null });
}

describe("resolveWhatsAppConversationGroupAllowFrom (#69926)", () => {
  it("returns the account-level groupAllowFrom when no per-group allowFrom is configured", () => {
    const policy = buildPolicyForCfg({
      channels: {
        whatsapp: {
          enabled: true,
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111", "+15550002222"],
        },
      },
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000000@g.us",
      }),
    ).toEqual(["+15550001111", "+15550002222"]);
  });

  it("uses per-group allowFrom when defined for the conversation JID", () => {
    const policy = buildPolicyForCfg({
      channels: {
        whatsapp: {
          enabled: true,
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
          groups: {
            "1203630000000000000@g.us": {
              allowFrom: ["+15550003333"],
            },
          },
        },
      },
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000000@g.us",
      }),
    ).toEqual(["+15550003333"]);
  });

  it("falls back to the account-level list when the per-group allowFrom is empty", () => {
    const policy = buildPolicyForCfg({
      channels: {
        whatsapp: {
          enabled: true,
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
          groups: {
            "1203630000000000000@g.us": {
              allowFrom: [],
            },
          },
        },
      },
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000000@g.us",
      }),
    ).toEqual(["+15550001111"]);
  });

  it("leaves other group JIDs on the account-level allowlist when one group has an override", () => {
    const policy = buildPolicyForCfg({
      channels: {
        whatsapp: {
          enabled: true,
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
          groups: {
            "1203630000000000000@g.us": {
              allowFrom: ["+15550003333"],
            },
          },
        },
      },
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000001@g.us",
      }),
    ).toEqual(["+15550001111"]);
  });

  it("honours an account-scoped groups[<jid>].allowFrom over a root-scope account default", () => {
    const policy = resolveWhatsAppInboundPolicy({
      cfg: {
        channels: {
          whatsapp: {
            enabled: true,
            groupPolicy: "allowlist",
            groupAllowFrom: ["+15550001111"],
            groups: {
              "1203630000000000000@g.us": {
                allowFrom: ["+15550009999"],
              },
            },
            accounts: {
              work: {
                groupAllowFrom: ["+15550008888"],
                groups: {
                  "1203630000000000000@g.us": {
                    allowFrom: ["+15550007777"],
                  },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      accountId: "work",
      selfE164: null,
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000000@g.us",
      }),
    ).toEqual(["+15550007777"]);
  });

  it("returns the account-level list when the policy has no groups map at all", () => {
    const policy = buildPolicyForCfg({
      channels: {
        whatsapp: {
          enabled: true,
          groupPolicy: "allowlist",
          groupAllowFrom: ["+15550001111"],
        },
      },
    });

    expect(
      resolveWhatsAppConversationGroupAllowFrom({
        policy,
        conversationId: "1203630000000000000@g.us",
      }),
    ).toEqual(["+15550001111"]);
  });
});
