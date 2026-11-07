import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { telegramSetupPlugin } from "./channel.setup.js";
import { telegramSecurityAdapter } from "./security.js";

describe("Telegram audit route completeness", () => {
  it.each([
    [undefined, undefined, undefined, "unknown"],
    [false, undefined, undefined, "complete"],
    [false, true, undefined, "unknown"],
    [true, true, false, "complete"],
    [false, false, true, "unknown"],
  ] as const)(
    "resolves global=%s channel=%s account=%s",
    async (global, channel, account, kind) => {
      const cfg: OpenClawConfig = {
        session: { threadBindings: { enabled: global } },
        channels: {
          telegram: {
            threadBindings: { enabled: channel },
            accounts: { work: { threadBindings: { enabled: account } } },
          },
        },
      };
      for (const security of [telegramSetupPlugin.security!, telegramSecurityAdapter]) {
        const result = await security.resolveAuditRouteTargets!({
          cfg,
          accountId: "work",
          env: {},
          stateDir: "/unused-telegram-audit-state",
        });
        expect(result).toEqual(kind === "complete" ? { kind, additionalAgentIds: [] } : { kind });
      }
    },
  );
});

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
