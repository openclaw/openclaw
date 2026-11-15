import {
  installChannelActionsContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../api.js";
import { SlackConfigSchema } from "../config-api.js";
import { slackSetupPlugin } from "../setup-plugin-api.js";
import { inspectSlackAccount } from "./account-inspect.js";

const httpCredentials = { mode: "http" as const, signingSecret: "test-signing-secret" };
const httpUserConfig = {
  ...httpCredentials,
  enabled: true,
  postAs: "user",
  userToken: "test-user-token",
};
function envTokens(appToken = "") {
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_APP_TOKEN", appToken);
}

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

function expectSlack(expected: Record<string, unknown>, absent: ("botToken" | "appToken")[] = []) {
  return (cfg: OpenClawConfig) => {
    expect(cfg.channels?.slack).toMatchObject(expected);
    for (const key of absent) {
      expect(cfg.channels?.slack?.[key]).toBeUndefined();
    }
  };
}

function promote(cfg: OpenClawConfig) {
  return moveSingleAccountChannelSectionToDefaultAccount({
    cfg,
    channelKey: "slack",
    setupSurface: slackSetupPlugin.setupContract,
  });
}

function expectSharedSigningSecret(cfg: OpenClawConfig, accountId: string) {
  expect(inspectSlackAccount({ cfg, accountId })).toMatchObject({
    configured: true,
    signingSecret: "shared-signing-secret",
  });
}

const slackDefaultActions = [
  "send",
  "channel-create",
  "conversation-open",
  "react",
  "reactions",
  "read",
  "edit",
  "delete",
  "download-file",
  "upload-file",
  "pin",
  "unpin",
  "list-pins",
  "member-info",
  "emoji-list",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

installChannelActionsContractSuite({
  plugin: slackPlugin,
  unsupportedAction: "poll",
  cases: [
    {
      name: "configured account exposes default Slack actions",
      cfg: slackConfig({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        actions: { channels: true },
      }),
      expectedActions: slackDefaultActions,
      expectedCapabilities: ["presentation"],
    },
    {
      name: "missing tokens disables the actions surface",
      cfg: slackConfig({ enabled: true }),
      expectedActions: [],
      expectedCapabilities: [],
    },
  ],
});

describe("slack setup contract", () => {
  it("keeps a shared HTTP signing secret at the channel root during account promotion", () => {
    const cfg = slackConfig({
      enabled: true,
      mode: "http",
      botToken: "xoxb-default",
      signingSecret: "shared-signing-secret",
    });

    const next = promote(cfg);

    expect(next.channels?.slack?.signingSecret).toBe("shared-signing-secret");
    expect(next.channels?.slack).not.toHaveProperty("botToken");
    expect(next.channels?.slack?.accounts?.default).toMatchObject({ botToken: "xoxb-default" });
    expectSharedSigningSecret(next, "default");
    expect(SlackConfigSchema.safeParse(next.channels?.slack).success).toBe(true);
  });

  it.each([
    {
      name: "an HTTP account with its own signing secret",
      account: {
        mode: "http" as const,
        botToken: "xoxb-target",
        signingSecret: "target-signing-secret",
      },
    },
    {
      name: "a Socket Mode account",
      account: { mode: "socket" as const, botToken: "xoxb-target", appToken: "xapp-target" },
    },
    {
      name: "a relay account",
      account: {
        mode: "relay" as const,
        botToken: "xoxb-target",
        relay: {
          url: "https://relay.example.test",
          authToken: "relay-auth-token",
          gatewayId: "relay-gateway",
        },
      },
    },
  ])("preserves sibling HTTP credentials when promoting $name", ({ account }) => {
    const cfg = slackConfig({
      enabled: true,
      mode: "http",
      signingSecret: "shared-signing-secret",
      accounts: {
        default: account,
        bot: { mode: "http", botToken: "xoxb-sibling" },
        user: { mode: "http", postAs: "user", userToken: "xoxp-sibling" },
      },
    });

    const next = promote(cfg);

    expect(next.channels?.slack?.signingSecret).toBe("shared-signing-secret");
    expect(SlackConfigSchema.safeParse(next.channels?.slack).success).toBe(true);
    expectSharedSigningSecret(next, "bot");
    expectSharedSigningSecret(next, "user");
  });

  it("recognizes HTTP bot accounts at the setup plugin boundary without an app token", () => {
    const cfg = slackConfig({ ...httpCredentials, botToken: "xoxb-test" });
    const account = slackSetupPlugin.config.resolveAccount(cfg, "default");

    expect(slackSetupPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(slackSetupPlugin.config.describeAccount?.(account, cfg)).toMatchObject({
      configured: true,
    });
  });

  installChannelSetupContractSuite({
    plugin: slackSetupPlugin,
    cases: [
      {
        name: "default account stores tokens and enables the channel",
        cfg: {} as OpenClawConfig,
        input: { botToken: "xoxb-test", appToken: "xapp-test" },
        expectedAccountId: "default",
        assertPatchedConfig: expectSlack({
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
        }),
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: { useEnv: true },
        expectedAccountId: "ops",
        expectedValidation: "Slack env tokens can only be used for the default account.",
      },
      {
        name: "HTTP env setup accepts a configured signing secret without an app token",
        cfg: slackConfig(httpCredentials),
        input: { useEnv: true },
        beforeTest: () => {
          expect(
            slackSetupPlugin.setupContract?.metadata.fields.find((field) => field.key === "useEnv"),
          ).toMatchObject({ kind: "boolean", envVars: ["SLACK_BOT_TOKEN"] });
          envTokens();
        },
        assertPatchedConfig: expectSlack({ ...httpCredentials, enabled: true }, ["appToken"]),
      },
      {
        name: "Socket Mode env setup rejects a missing app token",
        cfg: {} as OpenClawConfig,
        input: { useEnv: true },
        beforeTest: () => envTokens(),
        expectedValidation: "Slack Socket Mode requires SLACK_APP_TOKEN when using --use-env.",
      },
      {
        name: "Socket Mode env setup accepts bot and app tokens",
        cfg: {} as OpenClawConfig,
        input: { useEnv: true },
        beforeTest: () => envTokens("xapp-test"),
        assertPatchedConfig: expectSlack({ enabled: true }),
      },
      {
        name: "user identity stores the user and Socket Mode transport tokens",
        cfg: {} as OpenClawConfig,
        input: { identity: "user", userToken: "test-user-token", appToken: "test-app-token" },
        expectedAccountId: "default",
        assertPatchedConfig: expectSlack(
          {
            enabled: true,
            postAs: "user",
            userToken: "test-user-token",
            appToken: "test-app-token",
          },
          ["botToken"],
        ),
      },
      {
        name: "HTTP user identity stores the user token and signing secret",
        cfg: {} as OpenClawConfig,
        input: { ...httpCredentials, identity: "user", userToken: "test-user-token" },
        expectedAccountId: "default",
        assertPatchedConfig: expectSlack(httpUserConfig, ["botToken", "appToken"]),
      },
      {
        name: "existing user identity stores an HTTP mode update",
        cfg: slackConfig({
          postAs: "user",
          userToken: "test-old-user-token",
          appToken: "test-old-app-token",
        }),
        input: { ...httpCredentials, userToken: "test-user-token" },
        expectedAccountId: "default",
        assertPatchedConfig: expectSlack(httpUserConfig),
      },
      {
        name: "user identity rejects relay mode",
        cfg: slackConfig({ mode: "relay" }),
        input: { identity: "user", userToken: "test-user-token", appToken: "test-app-token" },
        expectedAccountId: "default",
        expectedValidation:
          'Slack user identity setup supports mode "socket" or "http", not "relay".',
      },
      {
        name: "user identity rejects the bot-only env shortcut",
        cfg: {} as OpenClawConfig,
        input: { identity: "user", useEnv: true },
        expectedAccountId: "default",
        expectedValidation:
          "Slack user identity setup does not support --use-env; configure userToken and the transport credential explicitly.",
      },
      {
        name: "HTTP bot identity stores the bot token and signing secret",
        cfg: {} as OpenClawConfig,
        input: { ...httpCredentials, identity: "bot", botToken: "test-bot-token" },
        expectedAccountId: "default",
        assertPatchedConfig: expectSlack(
          {
            ...httpCredentials,
            enabled: true,
            postAs: "bot",
            botToken: "test-bot-token",
          },
          ["appToken"],
        ),
      },
      {
        name: "HTTP bot identity rejects an app token without a signing secret",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "bot",
          mode: "http",
          botToken: "test-bot-token",
          appToken: "test-app-token",
        },
        expectedAccountId: "default",
        expectedValidation:
          "Slack HTTP mode requires --bot-token and --signing-secret (or --use-env).",
      },
    ],
  });
});

installChannelStatusContractSuite({
  plugin: slackPlugin,
  cases: [
    {
      name: "configured account produces a configured status snapshot",
      cfg: slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" }),
      runtime: { accountId: "default", connected: true, running: true },
      probe: { ok: true },
      assertSnapshot: (snapshot) => {
        expect(snapshot).toMatchObject({ accountId: "default", enabled: true, configured: true });
      },
    },
  ],
});
