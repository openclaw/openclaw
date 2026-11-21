import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it } from "vitest";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import { inspectSlackAccount } from "./account-inspect.js";
import { resolveSlackAccount } from "./accounts.js";

type SlackConfig = NonNullable<OpenClawConfig["channels"]>["slack"];
const botToken = "test-bot-token";
const appToken = "test-app-token";
const missingToken = (id: string) => ({ source: "env" as const, provider: "default", id });
const appRef = missingToken("MISSING_SLACK_APP_TOKEN");
const config = (slack: SlackConfig): OpenClawConfig => ({ channels: { slack } });
function expectAccount(slack: SlackConfig, expected: object, usable: boolean, envBotToken = "") {
  const account = inspectSlackAccount({
    cfg: config(slack),
    envBotToken,
    envAppToken: "",
    envUserToken: "",
  });
  expect(account).toMatchObject(expected);
  expect(isSlackPluginAccountConfigured({ ...account, identity: account.identity ?? "bot" })).toBe(
    usable,
  );
}

it("ignores inactive app-token refs and environment tokens in relay mode", () => {
  const cfg = config({
    mode: "relay",
    botToken,
    appToken: appRef,
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
  const inactiveApp = { appToken: undefined, appTokenSource: "none", appTokenStatus: "missing" };
  expect(account).toMatchObject({ configured: true, ...inactiveApp });
  expect(account).not.toHaveProperty("signingSecretStatus");
  expect(isSlackPluginAccountConfigured(resolveSlackAccount({ cfg }))).toBe(true);
  delete cfg.channels!.slack!.appToken;
  expect(inspectSlackAccount({ cfg, envAppToken: "test-env-app-token" })).toMatchObject(
    inactiveApp,
  );
});

it("keeps an active socket app-token ref unavailable and operational resolution strict", () => {
  const cfg = config({
    botToken,
    appToken: appRef,
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

it("does not fall through an unavailable configured ref to environment tokens", () => {
  expectAccount(
    { botToken: missingToken("OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN"), appToken },
    {
      botToken: undefined,
      botTokenSource: "config",
      botTokenStatus: "configured_unavailable",
      configured: true,
    },
    false,
    "xoxb-lower-precedence",
  );
});

it("keeps a healthy bot identity configured when its optional user token is unavailable", () => {
  expectAccount(
    {
      botToken,
      appToken,
      userToken: missingToken("OPENCLAW_TEST_MISSING_OPTIONAL_SLACK_USER_TOKEN"),
    },
    {
      configured: true,
      botTokenStatus: "available",
      appTokenStatus: "available",
      userTokenStatus: "configured_unavailable",
    },
    true,
  );
});

it("keeps incomplete required credentials unconfigured even when another token is unavailable", () => {
  expectAccount(
    { botToken: missingToken("OPENCLAW_TEST_MISSING_REQUIRED_SLACK_BOT_TOKEN") },
    { configured: false, botTokenStatus: "configured_unavailable", appTokenStatus: "missing" },
    false,
  );
});
