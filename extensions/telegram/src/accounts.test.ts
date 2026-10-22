import fs from "node:fs/promises";
import path from "node:path";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-mutation";
import {
  createCanonicalAgentConfigFixture,
  withEnv,
  withTempHome,
} from "openclaw/plugin-sdk/test-env";
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

function telegramConfig(
  telegram: NonNullable<OpenClawConfig["channels"]>["telegram"],
  rest: Omit<OpenClawConfig, "channels"> = {},
): OpenClawConfig {
  return { ...rest, channels: { telegram } };
}

function resolveAccountWithEnv(
  env: Record<string, string>,
  cfg: OpenClawConfig,
  accountId?: string,
) {
  return withEnv(env, () => resolveTelegramAccount({ cfg, ...(accountId ? { accountId } : {}) }));
}
function restrictedConfig(allowFrom: string[], root: TelegramAccountConfig = {}) {
  return telegramConfig({
    enabled: true,
    allowFrom: ["123"],
    ...root,
    accounts: { alerts: { botToken: "bot-token", dmPolicy: "open", allowFrom } },
  });
}

describe("resolveTelegramAccount", () => {
  it.each([
    [undefined, "work", "tok-work", "config"],
    ["default", "default", "", "none"],
  ])(
    "resolves fallback only for omitted accountId (%s)",
    (requested, accountId, token, tokenSource) => {
      const account = resolveAccountWithEnv(
        { TELEGRAM_BOT_TOKEN: "" },
        telegramConfig({ accounts: { work: { botToken: "tok-work" } } }),
        requested,
      );
      expect(account).toMatchObject({ accountId, tokenSource, token });
    },
  );

  it("does not resolve disabled account tokens when listing enabled accounts", () => {
    const cfg = telegramConfig({
      accounts: {
        disabled: {
          enabled: false,
          botToken: { source: "exec", provider: "vault", id: "telegram/disabled" },
        },
        work: { botToken: "tok-work" },
      },
    }) as unknown as OpenClawConfig;

    const accounts = listEnabledTelegramAccounts(cfg);

    expect(accounts.map((account) => account.accountId)).toEqual(["work"]);
    expect(accounts[0]?.token).toBe("tok-work");
  });

  it("preserves normalized agent-bound accounts and default-agent selection", () => {
    const cfg = telegramConfig(
      { botToken: "tok-default", accounts: { Alerts: { botToken: "tok-alerts" } } },
      {
        agents: { entries: { primary: {} } },
        bindings: [
          { agentId: "primary", match: { channel: "telegram", accountId: " Ops Team " } },
          { agentId: "another", match: { channel: "telegram", accountId: "ops-team" } },
          { agentId: "ignored", match: { channel: "telegram", accountId: "*" } },
          { agentId: "ignored", match: { channel: "slack", accountId: "slack-only" } },
        ],
      },
    ) as unknown as OpenClawConfig;

    expect(listTelegramAccountIds(cfg)).toEqual(["alerts", "default", "ops-team"]);
    expect(resolveDefaultTelegramAccountId(cfg)).toBe("ops-team");
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials (#82780)", () => {
    const cfg = telegramConfig(
      {
        botToken: "tok-default",
        accounts: { fusion: { enabled: false, name: "Fusion", botToken: "tok-fusion" } },
      },
      { bindings: [{ agentId: "fusion", match: { channel: "telegram", accountId: "fusion" } }] },
    ) as unknown as OpenClawConfig;

    expect(listTelegramAccountIds(cfg)).toEqual(["default", "fusion"]);
    expect(resolveDefaultTelegramAccountId(cfg)).toBe("default");

    const accounts = listEnabledTelegramAccounts(cfg);
    expect(accounts.map((account) => account.accountId)).toEqual(["default"]);
    expect(accounts[0]).toMatchObject({ token: "tok-default", tokenSource: "config" });
  });

  it.each([
    [undefined, " Secondary ", "secondary", "tok-secondary"],
    ["primary", "secondary", "primary", "tok-primary"],
  ])(
    "honors configured defaults without overriding explicit accountId (%s, #61012)",
    (requested, defaultAccount, accountId, token) => {
      const account = resolveAccountWithEnv(
        { TELEGRAM_BOT_TOKEN: "tok-env" },
        telegramConfig({
          botToken: "tok-top-level",
          defaultAccount,
          accounts: {
            primary: { botToken: "tok-primary" },
            secondary: { botToken: "tok-secondary" },
          },
        }),
        requested,
      );
      expect(account).toMatchObject({ accountId, token, tokenSource: "config" });
    },
  );
});

describe("resolveDefaultTelegramAccountId", () => {
  it("selects an account without requiring an ambient agent during legacy repair", () => {
    const cfg: OpenClawConfig = telegramConfig(
      { defaultAccount: "work", accounts: { alerts: {}, work: {} } },
      { agents: { entries: { main: {}, research: {} } } },
    );

    expect(resolveDefaultTelegramAccountId(cfg)).toBe("work");
  });

  it("uses explicit channel defaults after Doctor repairs a loaded legacy roster", async () => {
    await withTempHome(
      async (home) => {
        const config = {
          channels: {
            telegram: { defaultAccount: "alerts", accounts: { alerts: {}, work: {} } },
          },
          agents: { entries: { main: { default: true }, research: {} } },
          bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "work" } }],
        };
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        const original = JSON.stringify(config);
        await fs.writeFile(configPath, original);
        const { snapshot } = await readConfigFileSnapshotForWrite();

        expect(snapshot.valid).toBe(false);
        expect(snapshot.sourceConfig.agents?.entries?.main).toMatchObject({ default: true });
        expect(snapshot.sourceConfig.bindings).toEqual(config.bindings);
        expect(await fs.readFile(configPath, "utf8")).toBe(original);

        const { config: repaired } = createCanonicalAgentConfigFixture(snapshot.sourceConfig, {
          homedir: () => home,
        });
        expect(repaired.agents?.ownership).toBe("explicit");
        expect(repaired.agents?.entries?.main).not.toHaveProperty("default");
        expect(repaired.agents?.defaults?.systemAgent).toEqual({ agentId: "main" });
        expect(repaired.bindings).toContainEqual(config.bindings![0]);
        expect(resolveDefaultTelegramAccountId(repaired)).toBe("alerts");
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
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
      const cfg: OpenClawConfig = telegramConfig({
        legacyWebhook: root,
        accounts: { alerts: account === undefined ? {} : { legacyWebhook: account } },
      });
      expect(mergeTelegramAccountConfig(cfg, "alerts").legacyWebhook).toEqual(expected);
    },
  );

  it("drops account wildcard DM access when top-level allowFrom is restrictive", async () => {
    const cfg = restrictedConfig(["*"], { dmPolicy: "allowlist" });

    setTelegramRuntime(createPluginRuntimeMock());
    const merged = mergeTelegramAccountConfig(cfg, "alerts");
    expect(merged).toMatchObject({ botToken: "bot-token", dmPolicy: "open", allowFrom: ["123"] });
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
    const cfg = restrictedConfig(["456", "*"]);

    const merged = mergeTelegramAccountConfig(cfg, "alerts");
    expect(merged.allowFrom).toEqual(["456"]);
  });
});

describe("resolveTelegramAccount groups inheritance (#30673)", () => {
  const groups = { "-100123": { requireMention: false } };
  it.each<{
    accounts: Record<string, TelegramAccountConfig>;
    accountId: string;
    expected: TelegramAccountConfig["groups"];
  }>([
    {
      accounts: { default: { botToken: "123:default", groups: {} } },
      accountId: "default",
      expected: groups,
    },
    {
      accounts: { default: { botToken: "123:default" }, dev: { botToken: "456:dev" } },
      accountId: "dev",
      expected: groups,
    },
    {
      accounts: { default: { botToken: "123:default" }, dev: { botToken: "456:dev", groups: {} } },
      accountId: "dev",
      expected: {},
    },
  ])(
    "inherits groups only when not explicitly isolated: $accountId $expected (#79427)",
    ({ accounts, accountId, expected }) => {
      const cfg = telegramConfig({ groups, accounts });
      expect(resolveTelegramAccount({ cfg, accountId }).config.groups).toEqual(expected);
    },
  );
});
