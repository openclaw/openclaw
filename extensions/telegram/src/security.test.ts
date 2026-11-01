import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramSecurityAdapter } from "./security.js";

describe("Telegram direct policy admission", () => {
  it("uses current account configuration and original sender at each admission", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          direct: { "42": { tools: { deny: ["read"] } } },
          accounts: {
            work: {
              direct: {
                "42": {
                  tools: { deny: ["write"] },
                  toolsBySender: { "channel:telegram:42": { deny: ["exec"] } },
                },
              },
            },
          },
        },
      },
    };
    const requester = { accountId: "work", conversationId: "42", senderId: "42" };
    const admitted = telegramSecurityAdapter.resolveDirectToolPolicy({ cfg, ...requester });
    const next: OpenClawConfig = {
      channels: {
        telegram: {
          accounts: {
            work: { direct: { "42": { tools: { deny: ["write"] } } } },
          },
        },
      },
    };

    expect(admitted).toEqual({ deny: ["exec"] });
    expect(telegramSecurityAdapter.resolveDirectToolPolicy({ cfg: next, ...requester })).toEqual({
      deny: ["write"],
    });
    expect(
      telegramSecurityAdapter.resolveDirectToolPolicy({
        cfg,
        ...requester,
        senderPolicyMode: "never",
      }),
    ).toEqual({ deny: ["write"] });
    expect(admitted).toEqual({ deny: ["exec"] });
  });
});
