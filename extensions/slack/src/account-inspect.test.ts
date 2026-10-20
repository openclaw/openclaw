import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import { inspectSlackAccount } from "./account-inspect.js";
import { resolveSlackAccount } from "./accounts.js";

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

function missingToken(id: string) {
  return { source: "env" as const, provider: "default", id };
}

function inspect(slack: NonNullable<OpenClawConfig["channels"]>["slack"], envBotToken = "") {
  return inspectSlackAccount({
    cfg: slackConfig(slack),
    envBotToken,
    envAppToken: "",
    envUserToken: "",
  });
}

function isInspectedSlackAccountUsable(account: ReturnType<typeof inspectSlackAccount>): boolean {
  return isSlackPluginAccountConfigured({
    ...account,
    identity: account.identity ?? "bot",
  });
}

describe("inspectSlackAccount", () => {
  it("ignores inactive app-token refs and environment tokens in relay mode", () => {
    const cfg: OpenClawConfig = slackConfig({
      mode: "relay",
      botToken: "test-bot-token",
      appToken: missingToken("MISSING_SLACK_APP_TOKEN"),
      signingSecret: "test-signing-secret",
      relay: {
        url: "https://relay.example.test",
        authToken: "test-relay-auth",
        gatewayId: "test-gateway",
      },
    });
    const account = inspectSlackAccount({
      cfg,
      envBotToken: "",
      envAppToken: "test-env-app-token",
      envUserToken: "",
    });

    expect(account).toMatchObject({
      configured: true,
      appToken: undefined,
      appTokenSource: "none",
      appTokenStatus: "missing",
    });
    expect(isSlackPluginAccountConfigured(resolveSlackAccount({ cfg }))).toBe(true);
    expect(account).not.toHaveProperty("signingSecretStatus");

    delete cfg.channels!.slack!.appToken;
    expect(inspectSlackAccount({ cfg, envAppToken: "test-env-app-token" })).toMatchObject({
      appToken: undefined,
      appTokenSource: "none",
      appTokenStatus: "missing",
    });
  });

  it("keeps an active socket app-token ref unavailable and operational resolution strict", () => {
    const cfg: OpenClawConfig = slackConfig({
      botToken: "test-bot-token",
      appToken: missingToken("MISSING_SLACK_APP_TOKEN"),
      signingSecret: missingToken("MISSING_SLACK_SIGNING_SECRET"),
    });
    const account = inspectSlackAccount({ cfg, envAppToken: "test-env-app-token" });

    expect(account).toMatchObject({
      configured: true,
      appToken: undefined,
      appTokenSource: "config",
      appTokenStatus: "configured_unavailable",
    });
    expect(account).not.toHaveProperty("signingSecretStatus");
    expect(() => resolveSlackAccount({ cfg })).toThrow(/appToken/);
  });

  it.each([
    {
      name: "does not fall through an unavailable configured ref to environment tokens",
      slack: {
        botToken: missingToken("OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN"),
        appToken: "test-app-token",
      },
      env: "xoxb-lower-precedence",
      expected: {
        botToken: undefined,
        botTokenSource: "config",
        botTokenStatus: "configured_unavailable",
        configured: true,
      },
      usable: false,
    },
    {
      name: "keeps a healthy bot identity configured when its optional user token is unavailable",
      slack: {
        botToken: "test-bot-token",
        appToken: "test-app-token",
        userToken: missingToken("OPENCLAW_TEST_MISSING_OPTIONAL_SLACK_USER_TOKEN"),
      },
      expected: {
        configured: true,
        botTokenStatus: "available",
        appTokenStatus: "available",
        userTokenStatus: "configured_unavailable",
      },
      usable: true,
    },
    {
      name: "keeps incomplete required credentials unconfigured even when another token is unavailable",
      slack: { botToken: missingToken("OPENCLAW_TEST_MISSING_REQUIRED_SLACK_BOT_TOKEN") },
      expected: {
        configured: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
      },
      usable: false,
    },
  ])("$name", ({ slack, env, expected, usable }) => {
    const account = inspect(slack, env);
    expect(account).toMatchObject(expected);
    expect(isInspectedSlackAccountUsable(account)).toBe(usable);
  });
});
