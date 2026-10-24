import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createCanonicalAgentConfigFixture, withEnv } from "openclaw/plugin-sdk/test-env";
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

describe("resolveTelegramAccount", () => {
  it.each([
    [undefined, "work", "tok-work", "config"],
    ["default", "default", "", "none"],
  ])(
    "resolves fallback only for omitted accountId (%s)",
    (requested, accountId, token, tokenSource) => {
      const account = withEnv({ TELEGRAM_BOT_TOKEN: "" }, () =>
        resolveTelegramAccount({
          cfg: telegramConfig({ accounts: { work: { botToken: "tok-work" } } }),
          accountId: requested,
        }),
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

    expect(accounts).toMatchObject([{ accountId: "work", token: "tok-work" }]);
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
    expect(accounts).toMatchObject([
      { accountId: "default", token: "tok-default", tokenSource: "config" },
    ]);
  });

  it.each([
    [undefined, " Secondary ", "secondary", "tok-secondary"],
    ["primary", "secondary", "primary", "tok-primary"],
  ])(
    "honors configured defaults without overriding explicit accountId (%s, #61012)",
    (requested, defaultAccount, accountId, token) => {
      const account = withEnv({ TELEGRAM_BOT_TOKEN: "tok-env" }, () =>
        resolveTelegramAccount({
          cfg: telegramConfig({
            botToken: "tok-top-level",
            defaultAccount,
            accounts: {
              primary: { botToken: "tok-primary" },
              secondary: { botToken: "tok-secondary" },
            },
          }),
          accountId: requested,
        }),
      );
      expect(account).toMatchObject({ accountId, token, tokenSource: "config" });
    },
  );
});

describe("resolveDefaultTelegramAccountId", () => {
  it("selects an account without requiring an ambient agent during legacy repair", () => {
    expect(
      resolveDefaultTelegramAccountId(
        telegramConfig(
          { defaultAccount: "work", accounts: { alerts: {}, work: {} } },
          { agents: { entries: { main: {}, research: {} } } },
        ),
      ),
    ).toBe("work");
  });

  it("uses explicit channel defaults after Doctor repairs a legacy roster", () => {
    const binding = { agentId: "main", match: { channel: "telegram", accountId: "work" } };
    const { config } = createCanonicalAgentConfigFixture({
      channels: { telegram: { defaultAccount: "alerts", accounts: { alerts: {}, work: {} } } },
      agents: { entries: { main: { default: true }, research: {} } },
      bindings: [binding],
    });
    expect(config.agents?.ownership).toBe("explicit");
    expect(config.agents?.entries?.main).not.toHaveProperty("default");
    expect(config.agents?.defaults?.systemAgent).toEqual({ agentId: "main" });
    expect(config.bindings).toContainEqual(binding);
    expect(resolveDefaultTelegramAccountId(config)).toBe("alerts");
  });
});

describe("mergeTelegramAccountConfig", () => {
  afterEach(clearTelegramRuntimeForTest);
  function mergeRestricted(allowFrom: string[], root: TelegramAccountConfig = {}) {
    return mergeTelegramAccountConfig(
      telegramConfig({
        enabled: true,
        allowFrom: ["123"],
        ...root,
        accounts: { alerts: { botToken: "bot-token", dmPolicy: "open", allowFrom } },
      }),
      "alerts",
    );
  }
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
    setTelegramRuntime(createPluginRuntimeMock());
    const merged = mergeRestricted(["*"], { dmPolicy: "allowlist" });
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
    expect(mergeRestricted(["456", "*"]).allowFrom).toEqual(["456"]);
  });
});

describe("resolveTelegramAccount groups inheritance (#30673)", () => {
  const groups = { "-100123": { requireMention: false } };
  const defaultAccount = { botToken: "123:default" };
  const dev = { botToken: "456:dev" };
  it.each<[Record<string, TelegramAccountConfig>, string, TelegramAccountConfig["groups"]]>([
    [{ default: { ...defaultAccount, groups: {} } }, "default", groups],
    [{ default: defaultAccount, dev }, "dev", groups],
    [{ default: defaultAccount, dev: { ...dev, groups: {} } }, "dev", {}],
  ])(
    "inherits groups only when not explicitly isolated: %j %s %j (#79427)",
    (accounts, accountId, expected) => {
      const cfg = telegramConfig({ groups, accounts });
      expect(resolveTelegramAccount({ cfg, accountId }).config.groups).toEqual(expected);
    },
  );
});
