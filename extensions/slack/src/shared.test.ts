import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { slackSetupPlugin } from "./channel.setup.js";
import { setSlackChannelAllowlist } from "./setup-shared.js";
import { slackPluginBase as plugin, slackConfigAdapter } from "./shared.js";
type SlackConfig = NonNullable<OpenClawConfig["channels"]>["slack"];
const config = (slack: SlackConfig): OpenClawConfig => ({ channels: { slack } });

it("owns Slack native command name overrides", () => {
  const resolve = (commandKey: string) =>
    plugin.commands?.resolveNativeCommandName?.({ commandKey, defaultName: commandKey });
  expect([resolve("status"), resolve("tts"), resolve("login")]).toEqual([
    "agentstatus",
    "tts",
    "login",
  ]);
});

it("writes canonical enabled entries for setup-generated channel allowlists", () => {
  const result = setSlackChannelAllowlist(
    { channels: { slack: { accounts: { work: {} } } } },
    "work",
    ["C123", "C456"],
  );
  expect(result.channels?.slack?.accounts?.work?.channels).toEqual({
    C123: { enabled: true },
    C456: { enabled: true },
  });
});

describe("slackConfigAdapter", () => {
  it("clears user-identity credentials when deleting the root account", () => {
    const cfg = config({
      identity: "user",
      mode: "http",
      userToken: "test-user-token",
      signingSecret: "test-signing-secret",
      accounts: {
        work: {
          identity: "user",
          userToken: "test-work-user-token",
          appToken: "test-work-app-token",
        },
      },
    });

    const next = slackConfigAdapter.deleteAccount?.({ cfg, accountId: "default" });

    expect(next?.channels?.slack?.userToken).toBeUndefined();
    expect(next?.channels?.slack?.signingSecret).toBeUndefined();
    expect(next?.channels?.slack?.accounts?.work).toMatchObject({
      userToken: "test-work-user-token",
      appToken: "test-work-app-token",
    });
  });

  it("keeps read-only accessors from resolving token SecretRefs", () => {
    const provider = (name: string) => ({
      source: "file" as const,
      path: `/tmp/openclaw-missing-slack-${name}-token`,
      mode: "singleValue" as const,
    });
    const cfg = {
      secrets: {
        providers: {
          slack_bot: provider("bot"),
          slack_app: provider("app"),
        },
      },
      ...config({
        botToken: { source: "file", provider: "slack_bot", id: "value" },
        appToken: { source: "file", provider: "slack_app", id: "value" },
        allowFrom: ["U123"],
        defaultTo: "C123",
      }),
    };

    for (const adapter of [slackConfigAdapter, slackSetupPlugin.config]) {
      expect(adapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["U123"]);
      expect(adapter.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe("C123");
    }
  });
});
