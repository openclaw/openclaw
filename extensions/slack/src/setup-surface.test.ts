import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackSetupWizardBase, slackSetupContract } from "./setup-core.js";
import { buildSlackSetupLines } from "./setup-shared.js";

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

const slackSetupWizard = createSlackSetupWizardBase({
  promptAllowFrom: async ({ cfg }) => cfg,
  resolveAllowFromEntries: async ({ entries }) =>
    entries.map((input) => ({ input, resolved: false, id: null })),
  resolveGroupAllowlist: async ({ entries }) => entries,
});

const credentialOnlySlackSetupWizard = {
  ...slackSetupWizard,
  dmPolicy: undefined,
  allowFrom: undefined,
  groupAccess: undefined,
  finalize: undefined,
};

function configure(
  queued: ReturnType<typeof createQueuedWizardPrompter>,
  cfg: OpenClawConfig = {},
  accountId = "default",
) {
  const adapter = createSetupWizardAdapter({
    plugin: {
      id: "slack",
      meta: { label: "Slack" },
      config: {
        listAccountIds: () => [accountId],
        defaultAccountId: () => accountId,
      },
      setupContract: slackSetupContract,
    } as never,
    wizard: credentialOnlySlackSetupWizard,
  });
  return runSetupWizardConfigure({
    configure: adapter.configure,
    cfg,
    prompter: queued.prompter,
    options: { secretInputMode: "plaintext" },
  });
}

function textPrompts(queued: ReturnType<typeof createQueuedWizardPrompter>) {
  return queued.text.mock.calls.map(([params]) => (params as { message: string }).message);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

const baseCfg = slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" });

function requireFirstStringArg(mock: ReturnType<typeof vi.fn>, label: string): string {
  const [call] = mock.mock.calls;
  if (!call || typeof call[0] !== "string") {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

describe("slackSetupWizard.prepare", () => {
  it("gives HTTP bot setup signing guidance without a Socket Mode manifest", async () => {
    const plain = vi.fn<NonNullable<WizardPrompter["plain"]>>(async () => {});
    const note = vi.fn(async () => {});

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: slackConfig({ mode: "http" }),
      prompter: createTestWizardPrompter({ plain, note }),
    });

    const instructions = requireFirstStringArg(note, "Slack HTTP setup instructions");
    expect(instructions).toContain("Signing Secret");
    expect(instructions).toContain("public HTTPS Request URL");
    expect(note).toHaveBeenCalledWith(instructions, "Channel setup");
    expect(plain).not.toHaveBeenCalled();
  });

  it("prints the manifest as plain JSON when Slack is not configured", async () => {
    const plain = vi.fn<NonNullable<WizardPrompter["plain"]>>(async () => {});
    const note = vi.fn(async () => {});

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: slackConfig({}),
      prompter: createTestWizardPrompter({
        plain,
        note,
      }),
    });

    expect(plain).toHaveBeenCalledTimes(1);
    const lines = buildSlackSetupLines();
    expect(note).toHaveBeenCalledWith(lines.join("\n"), expect.any(String));
    expect(lines.join("\n")).not.toContain("Manifest (JSON):");
    expect(lines.join("\n")).not.toContain('"display_information"');
    expect(lines).toContain("3) Socket Mode: enable it and create an app-level token (xapp-...)");
    const manifest = requireFirstStringArg(plain, "Slack manifest plain text");
    expect(JSON.parse(manifest)).toEqual({
      display_information: {
        name: "OpenClaw",
        description: "OpenClaw app for OpenClaw",
      },
      features: {
        bot_user: {
          display_name: "OpenClaw",
          always_online: true,
        },
        app_home: {
          home_tab_enabled: true,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        agent_view: {
          agent_description: "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
          suggested_prompts: [
            ["What can you do?", "What can you help me with?"],
            ["Summarize this channel", "Summarize the recent activity in this channel."],
            ["Draft a reply", "Help me draft a reply."],
          ].map(([title, message]) => ({ title, message })),
        },
        slash_commands: [
          {
            command: "/openclaw",
            description: "Send a message to OpenClaw",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "assistant:write",
            "channels:history",
            "channels:manage",
            "channels:read",
            "channels:write.invites",
            "chat:write",
            "commands",
            "emoji:read",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "mpim:history",
            "mpim:read",
            "mpim:write",
            "pins:read",
            "pins:write",
            "reactions:read",
            "reactions:write",
            "usergroups:read",
            "users:read",
          ],
        },
      },
      settings: {
        socket_mode_enabled: true,
        event_subscriptions: {
          bot_events: [
            "app_home_opened",
            "app_mention",
            "app_context_changed",
            "agent_session_stopped",
            "agent_session_title_changed",
            "channel_rename",
            "member_joined_channel",
            "member_left_channel",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
            "pin_added",
            "pin_removed",
            "reaction_added",
            "reaction_removed",
          ],
        },
      },
    });
  });

  it("collects only the user token and Socket Mode transport token for user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      textValues: ["test-user-token", "test-app-token"],
    });
    const result = await configure(queued);

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
    });
    expect(result.cfg.channels?.slack?.botToken).toBeUndefined();
    expect(textPrompts(queued)).toEqual([
      "Enter Slack user OAuth token",
      "Enter Slack app token (xapp-...)",
    ]);
    expect(queued.note).toHaveBeenCalledTimes(1);
    const instructions = requireFirstStringArg(queued.note, "Slack user identity instructions");
    expect(instructions).toContain("User Token Scopes");
    expect(instructions).toContain("Subscribe to events on behalf of users");
    expect(instructions).toContain("/channels/slack#user-identity-post-as-a-real-person");
    expect(queued.select.mock.invocationCallOrder[0]).toBeLessThan(
      queued.note.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("collects a signing secret instead of an app token for HTTP user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      textValues: ["test-user-token", "test-signing-secret"],
    });
    const result = await configure(queued, slackConfig({ mode: "http" }));

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      postAs: "user",
      mode: "http",
      userToken: "test-user-token",
      signingSecret: "test-signing-secret",
    });
    expect(result.cfg.channels?.slack?.botToken).toBeUndefined();
    expect(result.cfg.channels?.slack?.appToken).toBeUndefined();
  });

  it("collects a signing secret instead of an app token for HTTP bot identity", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      textValues: ["test-bot-token", "test-signing-secret"],
    });
    const result = await configure(queued, slackConfig({ mode: "http" }));

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      mode: "http",
      botToken: "test-bot-token",
      signingSecret: "test-signing-secret",
    });
    expect(result.cfg.channels?.slack?.appToken).toBeUndefined();
    expect(textPrompts(queued)).toEqual([
      "Enter Slack bot token (xoxb-...)",
      "Enter Slack signing secret",
    ]);
  });

  it("does not use the Socket Mode environment shortcut for HTTP bot setup", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-env-test");
    vi.stubEnv("SLACK_APP_TOKEN", "xapp-env-test");
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      confirmValues: [true],
      textValues: ["test-signing-secret"],
    });
    const result = await configure(queued, slackConfig({ mode: "http" }));

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      mode: "http",
      signingSecret: "test-signing-secret",
    });
    expect(result.cfg.channels?.slack?.botToken).toBeUndefined();
    expect(result.cfg.channels?.slack?.appToken).toBeUndefined();
    expect(queued.confirm).toHaveBeenCalledTimes(1);
    expect(textPrompts(queued)).toEqual(["Enter Slack signing secret"]);
  });

  it("continues user setup after preserving a user-token SecretRef", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      confirmValues: [true],
      textValues: ["test-app-token"],
    });
    const userTokenRef = {
      source: "env" as const,
      provider: "default",
      id: "TEST_SLACK_USER_TOKEN",
    };

    const result = await configure(
      queued,
      slackConfig({
        accounts: {
          work: { postAs: "user", userToken: userTokenRef },
        },
      }),
      "work",
    );

    expect(result.cfg.channels?.slack?.accounts?.work).toMatchObject({
      postAs: "user",
      userToken: userTokenRef,
      appToken: "test-app-token",
    });
  });

  it.each([
    { name: "new setup", cfg: {} as OpenClawConfig },
    {
      name: "switch from user identity",
      cfg: slackConfig({ postAs: "user" }),
    },
  ])("keeps bot identity implicit for $name", async ({ cfg }) => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      textValues: ["test-bot-token", "test-app-token"],
    });
    const result = await configure(queued, cfg);

    expect(result.cfg.channels?.slack).toEqual({
      enabled: true,
      botToken: "test-bot-token",
      appToken: "test-app-token",
    });
  });

  it("keeps a named bot override when the channel default is user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      textValues: ["test-bot-token", "test-app-token"],
    });
    const result = await configure(
      queued,
      slackConfig({
        postAs: "user",
        userToken: "test-user-token",
        appToken: "test-user-app-token",
        accounts: {
          work: { userToken: "", appToken: "" },
        },
      }),
      "work",
    );

    expect(result.cfg.channels?.slack?.postAs).toBe("user");
    expect(result.cfg.channels?.slack?.accounts?.work).toMatchObject({
      enabled: true,
      postAs: "bot",
      botToken: "test-bot-token",
      appToken: "test-app-token",
    });
  });

  it("lets a configured user identity switch back to implicit bot", async () => {
    const queued = createQueuedWizardPrompter({ selectValues: ["bot"] });

    const result = await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: slackConfig({
        postAs: "user",
        userToken: "test-user-token",
        appToken: "test-app-token",
      }),
      prompter: queued.prompter,
    });

    expect(queued.select).toHaveBeenCalledTimes(1);
    expect(result?.cfg.channels?.slack).toMatchObject({
      enabled: true,
      userToken: "test-user-token",
      appToken: "test-app-token",
    });
    expect(result?.cfg.channels?.slack).not.toHaveProperty("postAs");
  });

  it("does not print the manifest after Slack credentials are configured", async () => {
    const queued = createQueuedWizardPrompter();

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: baseCfg,
      prompter: queued.prompter,
    });

    expect(queued.select).not.toHaveBeenCalled();
    expect(queued.plain).not.toHaveBeenCalled();
  });
});

describe("slackSetupWizard.dmPolicy", () => {
  installChannelDmPolicyContractSuite({
    dmPolicy: slackSetupWizard.dmPolicy!,
    cases: [
      {
        name: "Slack named accounts",
        channel: "slack",
        accountId: "alerts",
        accountConfig: { botToken: "xoxb-alerts", appToken: "xapp-alerts" },
        inheritedAllowFrom: ["U123"],
      },
    ],
  });
});

describe("slackSetupWizard.status", () => {
  it.each([
    {
      name: "Socket Mode",
      slack: {
        postAs: "user" as const,
        userToken: "test-user-token",
        appToken: "test-app-token",
      },
    },
    {
      name: "HTTP mode",
      slack: {
        postAs: "user" as const,
        mode: "http" as const,
        userToken: "test-user-token",
        signingSecret: "test-signing-secret",
      },
    },
  ])("treats a complete user-identity $name account as configured", async ({ slack }) => {
    expect(
      await slackSetupWizard.status.resolveConfigured({
        cfg: { channels: { slack } } as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await slackSetupWizard.status.resolveConfigured({
      cfg: slackConfig({
        defaultAccount: "work",
        botToken: "xoxb-root",
        appToken: "xapp-root",
        accounts: {
          alerts: {
            botToken: "xoxb-alerts",
            appToken: "xapp-alerts",
          },
          work: {
            botToken: "",
            appToken: "",
          },
        },
      }),
    });

    expect(configured).toBe(false);
  });
});
