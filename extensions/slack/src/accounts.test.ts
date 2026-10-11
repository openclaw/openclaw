// Slack tests cover accounts plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "./accounts.js";

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

describe("resolveSlackAccount allowFrom precedence", () => {
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = slackConfig({
      botToken: "xoxb-default",
      appToken: "xapp-default",
      accounts: {
        work: {
          enabled: false,
          botToken: "xoxb-work",
          appToken: "xapp-work",
        },
      },
    });

    expect(listSlackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSlackAccountId(cfg)).toBe("default");
    expect(listEnabledSlackAccounts(cfg).map((account) => account.accountId)).toEqual(["default"]);
  });

  it("merges account action gates over top-level defaults field-by-field", () => {
    const cfg = slackConfig({
      botToken: "xoxb-root",
      actions: {
        messages: false,
        pins: false,
      },
      accounts: {
        default: { botToken: "xoxb-default" },
        work: {
          botToken: "xoxb-work",
          actions: {
            reactions: true,
          },
        },
      },
    });

    expect(resolveSlackAccount({ cfg, accountId: "work" }).actions).toEqual({
      messages: false,
      pins: false,
      reactions: true,
    });
    expect(resolveSlackAccount({ cfg, accountId: "default" }).actions).toEqual({
      messages: false,
      pins: false,
    });
  });

  it("merges canonical account streaming over top-level defaults field-by-field", () => {
    const resolved = resolveSlackAccount({
      cfg: slackConfig({
        streaming: {
          mode: "progress",
          nativeTransport: true,
          preview: { toolProgress: true, commandText: "raw" },
          progress: { label: "Shelling", commandText: "status" },
          block: { enabled: true, coalesce: { minChars: 40, maxChars: 80, idleMs: 250 } },
        },
        accounts: {
          work: {
            botToken: "xoxb-work",
            appToken: "xapp-work",
            streaming: {
              progress: { nativeTaskCards: true },
              block: { coalesce: { idleMs: 500 } },
            },
          },
        },
      }),
      accountId: "work",
    });

    expect(resolved.config.streaming).toEqual({
      mode: "progress",
      nativeTransport: true,
      preview: { toolProgress: true, commandText: "raw" },
      progress: { label: "Shelling", commandText: "status", nativeTaskCards: true },
      block: { enabled: true, coalesce: { minChars: 40, maxChars: 80, idleMs: 500 } },
    });
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveSlackAccount({
      cfg: slackConfig({
        accounts: {
          default: {
            botToken: "xoxb-default",
            appToken: "xapp-default",
            allowFrom: ["default"],
          },
          work: { botToken: "xoxb-work", appToken: "xapp-work" },
        },
      }),
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("resolves mixed-case account keys for DM access settings", () => {
    const cfg = slackConfig({
      dmPolicy: "open",
      allowFrom: ["root"],
      accounts: {
        Work: {
          botToken: "xoxb-work",
          appToken: "xapp-work",
          dmPolicy: "allowlist",
          allowFrom: ["U123"],
        },
      },
    });

    expect(resolveSlackAccountDmPolicy({ cfg, accountId: "work" })).toBe("allowlist");
    expect(resolveSlackAccountAllowFrom({ cfg, accountId: "work" })).toEqual(["U123"]);
  });
});

describe("resolveSlackAccount active secret surfaces", () => {
  const secretRef = { source: "exec", provider: "default", id: "slack_token" } as const;
  it("does not read credentials for disabled accounts", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                enabled: false,
                botToken: secretRef,
                appToken: secretRef,
                userToken: secretRef,
                allowFrom: ["U999"],
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "default",
    });

    expect(resolved.botToken).toBeUndefined();
    expect(resolved.botTokenSource).toBe("none");
    expect(resolved.appToken).toBeUndefined();
    expect(resolved.appTokenSource).toBe("none");
    expect(resolved.userToken).toBeUndefined();
    expect(resolved.userTokenSource).toBe("none");
    expect(resolved.accountId).toBe("default");
    expect(resolved.config.allowFrom).toEqual(["U999"]);
  });

  it("preserves env fallback when no active config token is set", () => {
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-only";
    process.env.SLACK_APP_TOKEN = "xapp-env-only";
    try {
      // No SecretRef and no string token configured for the default account:
      // env fallback must still fire so env-only deployments (relying solely
      // on SLACK_BOT_TOKEN / SLACK_APP_TOKEN) keep working when callers like
      // `channel.ts` invoke sendMessageSlack without an explicit override.
      const resolved = resolveSlackAccount({
        cfg: slackConfig({
          accounts: {
            default: { allowFrom: ["U001"] },
          },
        }),
        accountId: "default",
      });

      expect(resolved.botToken).toBe("xoxb-env-only");
      expect(resolved.botTokenSource).toBe("env");
      expect(resolved.appToken).toBe("xapp-env-only");
      expect(resolved.appTokenSource).toBe("env");
    } finally {
      if (previousBotToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousBotToken;
      }
      if (previousAppToken === undefined) {
        delete process.env.SLACK_APP_TOKEN;
      } else {
        process.env.SLACK_APP_TOKEN = previousAppToken;
      }
    }
  });

  it("does not use env fallback for inactive credentials", () => {
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-bot";
    process.env.SLACK_APP_TOKEN = "xapp-env-app";
    try {
      const resolved = resolveSlackAccount({
        cfg: slackConfig({
          accounts: {
            default: {
              enabled: false,
            },
          },
        }),
        accountId: "default",
      });

      expect(resolved.botToken).toBeUndefined();
      expect(resolved.botTokenSource).toBe("none");
      expect(resolved.appToken).toBeUndefined();
      expect(resolved.appTokenSource).toBe("none");
    } finally {
      if (previousBotToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousBotToken;
      }
      if (previousAppToken === undefined) {
        delete process.env.SLACK_APP_TOKEN;
      } else {
        process.env.SLACK_APP_TOKEN = previousAppToken;
      }
    }
  });
});
