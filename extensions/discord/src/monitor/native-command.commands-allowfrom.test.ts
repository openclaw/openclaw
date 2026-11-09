import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { matchPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import * as dispatcherModule from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordNativeCommand } from "./native-command.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", { spy: true });
import {
  forwardNativeCommand,
  nativeCommandContext,
} from "./native-command.dispatch.test-support.js";
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";

const OWNER = "123456789012345678";
const OTHER = "999999999999999999";
const CHANNEL = "234567890123456789";
const GUILD = "345678901234567890";
const ownerUser = `user:${OWNER}`;
const ownerCommand = `discord:${OWNER}`;
const otherUser = `user:${OTHER}`;

function createInteraction(params?: { userId?: string }): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: params?.userId ?? OWNER,
    username: "discord-user",
    globalName: "Discord User",
    channelType: ChannelType.GuildText,
    channelId: CHANNEL,
    guildId: GUILD,
    guildName: "Test Guild",
    interactionId: "interaction-1",
  });
}

function createConfig(channelUsers?: string[]): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: [ownerUser] } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          [GUILD]: {
            channels: {
              [CHANNEL]: {
                enabled: true,
                requireMention: false,
                ...(channelUsers ? { users: channelUsers } : {}),
              },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

function createCommand(
  cfg: OpenClawConfig,
  discordConfig?: DiscordAccountConfig,
  commandSpec: NativeCommandSpec = { name: "ping", description: "Ping", acceptsArgs: false },
) {
  return createDiscordNativeCommand({
    command: commandSpec,
    ...nativeCommandContext(cfg, discordConfig),
    ephemeralDefault: true,
  });
}

function createDispatchSpy() {
  const dispatchSpy = vi.spyOn(dispatcherModule, "dispatchReplyWithDispatcher").mockResolvedValue({
    counts: { final: 1, block: 0, tool: 0 },
  } as never);
  vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
    dispatchChannelInboundTurnForTest,
  );
  return dispatchSpy;
}

const dispatchChannelInboundTurnForTest = forwardNativeCommand(
  (...args) => dispatcherModule.dispatchReplyWithDispatcher(...args),
  true,
);

function firstDispatchReplyCall(): Parameters<
  typeof dispatcherModule.dispatchReplyWithDispatcher
>[0] {
  const firstCall = vi.mocked(dispatcherModule.dispatchReplyWithDispatcher).mock.calls.at(0);
  if (!firstCall) {
    throw new Error("expected dispatchReplyWithDispatcher call");
  }
  return firstCall[0];
}

async function runGuildSlashCommand(params?: {
  userId?: string;
  channelUsers?: string[];
  commands?: OpenClawConfig["commands"];
  mutateConfig?: (cfg: OpenClawConfig) => void;
  runtimeDiscordConfig?: DiscordAccountConfig;
  commandSpec?: NativeCommandSpec;
  optionValues?: Record<string, string>;
  mutateInteraction?: (interaction: MockCommandInteraction) => void;
}) {
  const cfg = createConfig(params?.channelUsers);
  if (params?.commands) {
    cfg.commands = params.commands;
  }
  params?.mutateConfig?.(cfg);
  const command = createCommand(cfg, params?.runtimeDiscordConfig, params?.commandSpec);
  const interaction = createInteraction({ userId: params?.userId });
  interaction.options.getString.mockImplementation(
    (name: string) => params?.optionValues?.[name] ?? null,
  );
  params?.mutateInteraction?.(interaction);
  vi.mocked(matchPluginCommand).mockReturnValue(null);
  const dispatchSpy = createDispatchSpy();
  const runResult = await command.run(interaction);
  return { dispatchSpy, interaction, runResult };
}

async function expectAccess(params: Parameters<typeof runGuildSlashCommand>[0], allowed: boolean) {
  const { dispatchSpy, interaction } = await runGuildSlashCommand(params);
  expect(dispatchSpy).toHaveBeenCalledTimes(allowed ? 1 : 0);
  const content = "You are not authorized to use this command.";
  if (allowed) {
    expect(interaction.followUp).not.toHaveBeenCalledWith(expect.objectContaining({ content }));
  } else {
    expect(interaction.followUp).toHaveBeenCalledWith({ content, ephemeral: true });
    expect(interaction.reply).not.toHaveBeenCalled();
  }
}

afterEach(() => vi.restoreAllMocks());

it.each([false, true])("requires opt-in for explicit owner name matching: %s", async (enabled) => {
  await expectAccess(
    {
      commands: { ownerAllowFrom: ["discord:discord-user"] },
      mutateConfig: (cfg) => {
        cfg.channels!.discord!.dangerouslyAllowNameMatching = enabled;
      },
    },
    enabled,
  );
});

it.each<[string, boolean, Parameters<typeof runGuildSlashCommand>[0]]>([
  [
    "command allowlist overrides owner",
    true,
    {
      userId: OTHER,
      commands: { ownerAllowFrom: [ownerCommand], allowFrom: { discord: [otherUser] } },
    },
  ],
  ["global command allowlist", true, { commands: { allowFrom: { "*": [ownerUser] } } }],
  ["channel includes member", true, { channelUsers: [ownerUser], commands: {} }],
  ["channel excludes member", false, { userId: OTHER, channelUsers: [ownerUser], commands: {} }],
  [
    "Discord owner restriction",
    false,
    {
      userId: OTHER,
      commands: {},
      mutateConfig: (cfg) => {
        cfg.channels!.discord!.allowFrom = [ownerUser];
      },
    },
  ],
  [
    "command owner rejects despite channel gate",
    false,
    {
      userId: OTHER,
      commands: { ownerAllowFrom: [ownerCommand] },
    },
  ],
  [
    "matching guild allowlist",
    true,
    {
      userId: OTHER,
      commands: { allowFrom: { discord: [`guild:${GUILD}`] } },
    },
  ],
  [
    "nonmatching guild allowlist",
    false,
    {
      userId: OTHER,
      commands: { allowFrom: { discord: ["guild:000000000000000000"] } },
    },
  ],
])("enforces %s", async (_name, allowed, params) => {
  await expectAccess(params, allowed);
});

it("uses the root discord maxLinesPerMessage when runtime discordConfig omits it", async () => {
  const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
  const { interaction } = await runGuildSlashCommand({
    mutateConfig: (cfg) => {
      cfg.channels!.discord!.maxLinesPerMessage = 120;
    },
    runtimeDiscordConfig: createConfig().channels!.discord,
  });

  await firstDispatchReplyCall().dispatcherOptions.deliver({ text: longReply }, { kind: "final" });

  expect(interaction.followUp).toHaveBeenCalledWith({ content: longReply, ephemeral: true });
  expect(interaction.reply).not.toHaveBeenCalled();
});

const structuredDiscordArgCases: Array<{
  command: string;
  optionValues: Record<string, string>;
  expectedPrompt: string;
}> = [
  {
    command: "config",
    optionValues: { action: " GET ", path: " agents.defaults.model " },
    expectedPrompt: "/config get agents.defaults.model",
  },
  { command: "debug", optionValues: { action: "unset" }, expectedPrompt: "/debug unset" },
];

it.each(structuredDiscordArgCases)(
  "serializes structured /$command args and delivers the visible reply",
  async ({ command, optionValues, expectedPrompt }) => {
    const visibleReply = `Handled ${expectedPrompt}`;
    const { interaction } = await runGuildSlashCommand({
      commandSpec: {
        name: command,
        description: `Test ${command}`,
        acceptsArgs: true,
      },
      optionValues,
    });
    const dispatchCall = firstDispatchReplyCall();

    expect(dispatchCall.ctx.Body).toBe(expectedPrompt);
    expect(dispatchCall.ctx.CommandArgs?.raw).toBe(expectedPrompt.slice(command.length + 2));

    await dispatchCall.dispatcherOptions.deliver({ text: visibleReply }, { kind: "final" });

    expect(interaction.followUp).toHaveBeenCalledWith({
      content: visibleReply,
      ephemeral: true,
    });
    expect(interaction.reply).not.toHaveBeenCalled();
  },
);

it("swallows expired slash interactions before dispatch when defer returns Unknown interaction", async () => {
  const { dispatchSpy, interaction, runResult } = await runGuildSlashCommand({
    mutateInteraction: (expiredInteraction) => {
      expiredInteraction.defer.mockRejectedValue({
        status: 404,
        discordCode: 10062,
        rawBody: { message: "Unknown interaction", code: 10062 },
      });
    },
  });

  expect(runResult).toBeUndefined();
  expect(interaction.defer).toHaveBeenCalledTimes(1);
  expect(dispatchSpy).not.toHaveBeenCalled();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.followUp).not.toHaveBeenCalled();
});

installDiscordIngressTestRuntime();
