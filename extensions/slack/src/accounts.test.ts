import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listEnabledSlackAccounts,
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "./accounts.js";

type SlackConfig = NonNullable<OpenClawConfig["channels"]>["slack"];
const slackConfig = (slack: SlackConfig): OpenClawConfig => ({ channels: { slack } });

function resolveAccount(slack: Parameters<typeof slackConfig>[0], accountId = "default") {
  return resolveSlackAccount({ cfg: slackConfig(slack), accountId });
}

afterEach(() => vi.unstubAllEnvs());

describe("resolveSlackAccount allowFrom precedence", () => {
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = slackConfig({
      botToken: "xoxb-default",
      appToken: "xapp-default",
      accounts: { work: { enabled: false, botToken: "xoxb-work", appToken: "xapp-work" } },
    });

    expect(listSlackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultSlackAccountId(cfg)).toBe("default");
    expect(listEnabledSlackAccounts(cfg).map((account) => account.accountId)).toEqual(["default"]);
  });

  it("merges canonical account streaming over top-level defaults field-by-field", () => {
    const resolved = resolveAccount(
      {
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
      },
      "work",
    );

    expect(resolved.config.streaming).toEqual({
      mode: "progress",
      nativeTransport: true,
      preview: { toolProgress: true, commandText: "raw" },
      progress: { label: "Shelling", commandText: "status", nativeTaskCards: true },
      block: { enabled: true, coalesce: { minChars: 40, maxChars: 80, idleMs: 500 } },
    });
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveAccount(
      {
        accounts: {
          default: {
            botToken: "xoxb-default",
            appToken: "xapp-default",
            allowFrom: ["default"],
          },
          work: { botToken: "xoxb-work", appToken: "xapp-work" },
        },
      },
      "work",
    );

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
    const resolved = resolveAccount({
      accounts: {
        default: {
          enabled: false,
          botToken: secretRef,
          appToken: secretRef,
          userToken: secretRef,
          allowFrom: ["U999"],
        },
      },
    });

    expect(resolved).toMatchObject({
      botToken: undefined,
      botTokenSource: "none",
      appToken: undefined,
      appTokenSource: "none",
      userToken: undefined,
      userTokenSource: "none",
      accountId: "default",
      config: { allowFrom: ["U999"] },
    });
  });

  it("preserves env fallback when no active config token is set", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env-only");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env-only");
    const resolved = resolveAccount({ accounts: { default: { allowFrom: ["U001"] } } });

    expect(resolved).toMatchObject({
      botToken: "xoxb-env-only",
      botTokenSource: "env",
      appToken: "xapp-env-only",
      appTokenSource: "env",
    });
  });

  it("does not use env fallback for inactive credentials", () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env-bot");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env-app");
    const resolved = resolveAccount({ accounts: { default: { enabled: false } } });

    expect(resolved).toMatchObject({
      botToken: undefined,
      botTokenSource: "none",
      appToken: undefined,
      appTokenSource: "none",
    });
  });
});
