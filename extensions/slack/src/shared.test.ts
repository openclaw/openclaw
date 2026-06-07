// Slack tests cover shared plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import type { ResolvedSlackAccount } from "./accounts.js";
import {
  createSlackPluginBase,
  isSlackPluginAccountConfigured,
  setSlackChannelAllowlist,
  slackConfigAdapter,
} from "./shared.js";

function createAccount(
  overrides: Partial<ResolvedSlackAccount> & {
    config?: Partial<ResolvedSlackAccount["config"]>;
  } = {},
): ResolvedSlackAccount {
  const { config: configOverrides, ...accountOverrides } = overrides;
  return {
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test",
    appToken: undefined,
    userToken: undefined,
    botTokenSource: "config",
    appTokenSource: "none",
    userTokenSource: "none",
    config: {
      mode: "socket",
      ...configOverrides,
    } as ResolvedSlackAccount["config"],
    ...accountOverrides,
  };
}

describe("createSlackPluginBase", () => {
  it("owns Slack native command name overrides", () => {
    const plugin = createSlackPluginBase({
      setup: {} as never,
      setupWizard: {} as never,
    });

    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "status",
        defaultName: "status",
      }),
    ).toBe("agentstatus");
    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "tts",
        defaultName: "tts",
      }),
    ).toBe("tts");
  });

  it("exposes security checks on the setup surface", () => {
    const plugin = createSlackPluginBase({
      setup: {} as never,
      setupWizard: {} as never,
    });

    expect(plugin.security?.resolveDmPolicy).toBeTypeOf("function");
    expect(plugin.security?.collectWarnings).toBeTypeOf("function");
    expect(plugin.security?.collectAuditFindings).toBeTypeOf("function");
  });
});

describe("setSlackChannelAllowlist", () => {
  it("writes canonical enabled entries for setup-generated channel allowlists", () => {
    const result = setSlackChannelAllowlist(
      {
        channels: {
          slack: {
            accounts: {
              work: {},
            },
          },
        },
      },
      "work",
      ["C123", "C456"],
    );

    expect(result.channels?.slack?.accounts?.work?.channels).toEqual({
      C123: { enabled: true },
      C456: { enabled: true },
    });
  });
});

describe("slackConfigAdapter", () => {
  it("keeps read-only accessors from resolving token SecretRefs", () => {
    const cfg = {
      secrets: {
        providers: {
          slack_bot: {
            source: "file",
            path: "/tmp/openclaw-missing-slack-bot-token",
            mode: "singleValue",
          },
          slack_app: {
            source: "file",
            path: "/tmp/openclaw-missing-slack-app-token",
            mode: "singleValue",
          },
        },
      },
      channels: {
        slack: {
          botToken: { source: "file", provider: "slack_bot", id: "value" },
          appToken: { source: "file", provider: "slack_app", id: "value" },
          allowFrom: ["U123"],
          defaultTo: "C123",
        },
      },
    } as unknown as OpenClawConfig;

    expect(slackConfigAdapter.resolveAllowFrom?.({ cfg, accountId: "default" })).toEqual(["U123"]);
    expect(slackConfigAdapter.resolveDefaultTo?.({ cfg, accountId: "default" })).toBe("C123");
  });
});

describe("isSlackPluginAccountConfigured", () => {
  it("treats trusted-upstream as configured with only a bot token", () => {
    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          botToken: "xoxb-placeholder-proxied",
          appToken: undefined,
          config: {
            mode: "trusted-upstream",
          },
        }),
      ),
    ).toBe(true);
  });

  it("treats trusted-upstream as unconfigured without a bot token", () => {
    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          botToken: undefined,
          appToken: undefined,
          config: {
            mode: "trusted-upstream",
          },
        }),
      ),
    ).toBe(false);
  });

  it("still requires an app token for socket mode", () => {
    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          config: {
            mode: "socket",
          },
        }),
      ),
    ).toBe(false);

    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          appToken: "xapp-test",
          config: {
            mode: "socket",
          },
        }),
      ),
    ).toBe(true);
  });

  it("still requires a signing secret for http mode", () => {
    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          config: {
            mode: "http",
          },
        }),
      ),
    ).toBe(false);

    expect(
      isSlackPluginAccountConfigured(
        createAccount({
          config: {
            mode: "http",
            signingSecret: "secret",
          },
        }),
      ),
    ).toBe(true);
  });
});
