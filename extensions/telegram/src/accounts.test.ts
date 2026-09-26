// Telegram tests cover accounts plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import { withEnv, withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  listEnabledTelegramAccounts,
  listTelegramAccountIds,
  mergeTelegramAccountConfig,
  resolveDefaultTelegramAccountId,
  resolveTelegramAccount,
} from "./accounts.js";
import { normalizeAllowFrom } from "./bot-access.js";
import { isTelegramDmAccessAllowed } from "./dm-access.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";

function resolveAccountWithEnv(
  env: Record<string, string>,
  cfg: OpenClawConfig,
  accountId?: string,
) {
  return withEnv(env, () => resolveTelegramAccount({ cfg, ...(accountId ? { accountId } : {}) }));
}

describe("resolveTelegramAccount", () => {
  it("falls back to the first configured account when accountId is omitted", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "" },
      {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      },
    );
    expect(account.accountId).toBe("work");
    expect(account.token).toBe("tok-work");
    expect(account.tokenSource).toBe("config");
  });

  it("does not fall back when accountId is explicitly provided", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "" },
      {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      },
      "default",
    );
    expect(account.accountId).toBe("default");
    expect(account.tokenSource).toBe("none");
    expect(account.token).toBe("");
  });

  it("does not resolve disabled account tokens when listing enabled accounts", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            disabled: {
              enabled: false,
              botToken: { source: "exec", provider: "vault", id: "telegram/disabled" },
            },
            work: { botToken: "tok-work" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const accounts = listEnabledTelegramAccounts(cfg);

    expect(accounts.map((account) => account.accountId)).toEqual(["work"]);
    expect(accounts[0]?.token).toBe("tok-work");
  });

  it("preserves normalized agent-bound accounts and default-agent selection", () => {
    const cfg = {
      agents: { entries: { primary: { default: true } } },
      channels: {
        telegram: {
          botToken: "tok-default",
          accounts: { Alerts: { botToken: "tok-alerts" } },
        },
      },
      bindings: [
        { agentId: "primary", match: { channel: "telegram", accountId: " Ops Team " } },
        { agentId: "another", match: { channel: "telegram", accountId: "ops-team" } },
        { agentId: "ignored", match: { channel: "telegram", accountId: "*" } },
        { agentId: "ignored", match: { channel: "slack", accountId: "slack-only" } },
      ],
    } as unknown as OpenClawConfig;

    expect(listTelegramAccountIds(cfg)).toEqual(["alerts", "default", "ops-team"]);
    expect(resolveDefaultTelegramAccountId(cfg)).toBe("ops-team");
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials (#82780)", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok-default",
          accounts: {
            fusion: {
              enabled: false,
              name: "Fusion",
              botToken: "tok-fusion",
            },
          },
        },
      },
      bindings: [{ agentId: "fusion", match: { channel: "telegram", accountId: "fusion" } }],
    } as unknown as OpenClawConfig;

    expect(listTelegramAccountIds(cfg)).toEqual(["default", "fusion"]);
    expect(resolveDefaultTelegramAccountId(cfg)).toBe("default");

    const accounts = listEnabledTelegramAccounts(cfg);
    expect(accounts.map((account) => account.accountId)).toEqual(["default"]);
    expect(accounts[0]?.token).toBe("tok-default");
    expect(accounts[0]?.tokenSource).toBe("config");
  });

  it("routes omitted-account resolution through the configured defaultAccount (#61012)", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "tok-env" },
      {
        channels: {
          telegram: {
            botToken: "tok-top-level",
            defaultAccount: " Secondary ",
            accounts: {
              primary: { botToken: "tok-primary" },
              secondary: { botToken: "tok-secondary" },
            },
          },
        },
      },
    );
    expect(account.accountId).toBe("secondary");
    expect(account.token).toBe("tok-secondary");
    expect(account.tokenSource).toBe("config");
  });

  it("keeps explicit accountId ahead of the configured defaultAccount (#61012)", () => {
    const account = resolveAccountWithEnv(
      { TELEGRAM_BOT_TOKEN: "tok-env" },
      {
        channels: {
          telegram: {
            botToken: "tok-top-level",
            defaultAccount: "secondary",
            accounts: {
              primary: { botToken: "tok-primary" },
              secondary: { botToken: "tok-secondary" },
            },
          },
        },
      },
      "primary",
    );
    expect(account.accountId).toBe("primary");
    expect(account.token).toBe("tok-primary");
    expect(account.tokenSource).toBe("config");
  });
});

describe("resolveDefaultTelegramAccountId", () => {
  it("selects an account without requiring an ambient agent during legacy repair", () => {
    const cfg: OpenClawConfig = {
      agents: { entries: { main: {}, research: {} } },
      channels: {
        telegram: {
          defaultAccount: "work",
          accounts: { alerts: {}, work: {} },
        },
      },
    };

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("work");
  });

  it("preserves a loaded legacy owner's account until explicit fleet ownership is applied", async () => {
    await withTempHome(
      async (home) => {
        const config: OpenClawConfig = {
          agents: { entries: { main: { default: true }, research: {} } },
          channels: {
            telegram: {
              defaultAccount: "alerts",
              accounts: { alerts: {}, work: {} },
            },
          },
          bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
        };
        await fs.writeFile(path.join(home, ".openclaw", "openclaw.json"), JSON.stringify(config));
        const { snapshot } = await readConfigFileSnapshotForWrite();

        expect(snapshot.valid).toBe(true);
        expect(resolveDefaultTelegramAccountId(snapshot.config)).toBe("work");
        snapshot.config.agents!.ownership = "explicit";
        expect(resolveDefaultTelegramAccountId(snapshot.config)).toBe("alerts");
      },
      {
        env: {
          OPENCLAW_CONFIG_PATH: (home) => path.join(home, ".openclaw", "openclaw.json"),
          TELEGRAM_BOT_TOKEN: "",
        },
      },
    );
  });
});

describe("mergeTelegramAccountConfig", () => {
  afterEach(clearTelegramRuntimeForTest);
  it.each([
    { root: { port: 9000 }, account: undefined, expected: { port: 9000 } },
    { root: { port: 9000 }, account: false, expected: false },
    { root: false, account: undefined, expected: false },
    { root: false, account: { port: 9001 }, expected: { port: 9001 } },
  ] as const)(
    "preserves legacy listener inheritance and false override %j",
    ({ root, account, expected }) => {
      const cfg: OpenClawConfig = {
        channels: {
          telegram: {
            legacyWebhook: root,
            accounts: { alerts: account === undefined ? {} : { legacyWebhook: account } },
          },
        },
      };
      expect(mergeTelegramAccountConfig(cfg, "alerts").legacyWebhook).toEqual(expected);
    },
  );

  it("drops account wildcard DM access when top-level allowFrom is restrictive", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["123"],
          accounts: {
            alerts: {
              enabled: true,
              botToken: "bot-token",
              dmPolicy: "open",
              allowFrom: ["*"],
            },
          },
        },
      },
    };

    setTelegramRuntime(createPluginRuntimeMock());
    const merged = mergeTelegramAccountConfig(cfg, "alerts");
    expect(merged.botToken).toBe("bot-token");
    expect(merged.dmPolicy).toBe("open");
    expect(merged.allowFrom).toEqual(["123"]);
    for (const senderId of [123, 456]) {
      expect(
        await isTelegramDmAccessAllowed({
          accountId: "alerts",
          dmPolicy: "open",
          chatId: 42,
          effectiveDmAllow: normalizeAllowFrom(merged.allowFrom),
          msg: {
            message_id: 1,
            date: 1,
            chat: { id: 42, type: "private", first_name: "Ada" },
            from: { id: senderId, is_bot: false, first_name: "Ada" },
            text: "hello",
          },
        }),
      ).toBe(senderId === 123);
    }
  });

  it("keeps explicit account allowlist entries while dropping a conflicting wildcard", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          enabled: true,
          allowFrom: ["123"],
          accounts: {
            alerts: {
              botToken: "bot-token",
              dmPolicy: "open",
              allowFrom: ["456", "*"],
            },
          },
        },
      },
    };

    const merged = mergeTelegramAccountConfig(cfg, "alerts");
    expect(merged.allowFrom).toEqual(["456"]);
  });
});

describe("resolveTelegramAccount groups inheritance (#30673)", () => {
  const createMultiAccountGroupsConfig = (): OpenClawConfig => ({
    channels: {
      telegram: {
        groups: { "-100123": { requireMention: false } },
        accounts: {
          default: { botToken: "123:default" },
          dev: { botToken: "456:dev" },
        },
      },
    },
  });

  it("inherits channel-level groups when single-account explicitly sets `groups: {}` (regression: #79427)", () => {
    const resolved = resolveTelegramAccount({
      cfg: {
        channels: {
          telegram: {
            groups: { "-100123": { requireMention: false } },
            accounts: {
              default: { botToken: "123:default", groups: {} },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("inherits channel-level groups to secondary account when no account map is configured", () => {
    const resolved = resolveTelegramAccount({
      cfg: createMultiAccountGroupsConfig(),
      accountId: "dev",
    });

    expect(resolved.config.groups).toEqual({ "-100123": { requireMention: false } });
  });

  it("keeps an explicit empty account groups map isolated in multi-account setup", () => {
    const cfg = createMultiAccountGroupsConfig();
    if (!cfg.channels?.telegram?.accounts?.dev) {
      throw new Error("expected dev Telegram account");
    }
    cfg.channels.telegram.accounts.dev.groups = {};

    const resolved = resolveTelegramAccount({ cfg, accountId: "dev" });

    expect(resolved.config.groups).toEqual({});
  });
});
