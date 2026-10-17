// Discord tests cover native command.commands allowfrom plugin behavior.
import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { NativeCommandSpec } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { matchPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import * as dispatcherModule from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { createDiscordNativeCommand } from "./native-command.js";

vi.mock("openclaw/plugin-sdk/plugin-runtime", { spy: true });
import {
  createMockCommandInteraction,
  type MockCommandInteraction,
} from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

function createInteraction(params?: { userId?: string }): MockCommandInteraction {
  return createMockCommandInteraction({
    userId: params?.userId ?? "123456789012345678",
    username: "discord-user",
    globalName: "Discord User",
    channelType: ChannelType.GuildText,
    channelId: "234567890123456789",
    guildId: "345678901234567890",
    guildName: "Test Guild",
    interactionId: "interaction-1",
  });
}

function createConfig(channelUsers?: string[]): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: ["user:123456789012345678"] } },
    channels: {
      discord: {
        groupPolicy: "allowlist",
        guilds: {
          "345678901234567890": {
            channels: {
              "234567890123456789": {
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
    cfg,
    discordConfig: discordConfig ?? cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
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

const dispatchChannelInboundTurnForTest: typeof channelInbound.dispatchChannelInboundTurn = async (
  plan,
) => {
  const dispatchResult = await dispatcherModule.dispatchReplyWithDispatcher({
    ctx: plan.ctxPayload,
    cfg: plan.cfg,
    dispatcherOptions: {
      ...plan.dispatcherOptions,
      deliver: async (payload, info) => {
        if (!("deliver" in plan.delivery) || !plan.delivery.deliver) {
          throw new Error("expected core-managed Discord delivery");
        }
        await plan.delivery.deliver(payload, info);
      },
      onError: plan.delivery.onError,
    },
    replyOptions: plan.replyOptions,
  });
  return {
    admission: { kind: "dispatch" },
    dispatched: true,
    ctxPayload: plan.ctxPayload,
    routeSessionKey: plan.route.sessionKey,
    dispatchResult,
  };
};

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

async function runAuthorizedCommand(params?: Parameters<typeof runGuildSlashCommand>[0]) {
  const result = await runGuildSlashCommand(params);
  expect(result.dispatchSpy).toHaveBeenCalledTimes(1);
  expectNotUnauthorizedReply(result.interaction);
  return result;
}

async function runUnauthorizedCommand(params: Parameters<typeof runGuildSlashCommand>[0]) {
  const result = await runGuildSlashCommand(params);
  expect(result.dispatchSpy).not.toHaveBeenCalled();
  expectUnauthorizedReply(result.interaction);
}

function expectNotUnauthorizedReply(interaction: MockCommandInteraction) {
  const unauthorizedReplies = interaction.followUp.mock.calls.filter(([payload]) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return false;
    }
    return (
      (payload as { content?: unknown }).content === "You are not authorized to use this command."
    );
  });
  expect(unauthorizedReplies).toEqual([]);
}

function expectUnauthorizedReply(interaction: MockCommandInteraction) {
  expect(interaction.followUp).toHaveBeenCalledWith({
    content: "You are not authorized to use this command.",
    ephemeral: true,
  });
  expect(interaction.reply).not.toHaveBeenCalled();
}

describe("Discord native slash commands with commands.allowFrom", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
      dispatchChannelInboundTurnForTest,
    );
  });

  it.each([false, true])(
    "preserves explicit owner name compatibility only when opted in: %s",
    async (dangerouslyAllowNameMatching) => {
      const { dispatchSpy, interaction } = await runGuildSlashCommand({
        mutateConfig: (cfg) => {
          cfg.commands = { ownerAllowFrom: ["discord:discord-user"] };
          cfg.channels!.discord!.dangerouslyAllowNameMatching = dangerouslyAllowNameMatching;
        },
      });
      if (dangerouslyAllowNameMatching) {
        expect(dispatchSpy).toHaveBeenCalledOnce();
        expectNotUnauthorizedReply(interaction);
      } else {
        expect(dispatchSpy).not.toHaveBeenCalled();
        expectUnauthorizedReply(interaction);
      }
    },
  );

  it("authorizes command allowlist users even when commands.ownerAllowFrom is also configured", async () => {
    await runAuthorizedCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {
          ownerAllowFrom: ["discord:123456789012345678"],
          allowFrom: { discord: ["user:999999999999999999"] },
        };
      },
    });
  });

  it("authorizes guild slash commands from the global commands.allowFrom list when provider-specific allowFrom is missing", async () => {
    await runAuthorizedCommand({
      commands: { allowFrom: { "*": ["user:123456789012345678"] } },
    });
  });

  it("authorizes guild slash commands when channel access restrictions include the member", async () => {
    await runAuthorizedCommand({ channelUsers: ["user:123456789012345678"], commands: {} });
  });

  it("rejects guild slash commands when channel access restrictions exclude the member even if channel policy would allow them", async () => {
    await runUnauthorizedCommand({
      userId: "999999999999999999",
      channelUsers: ["user:123456789012345678"],
      commands: {},
    });
  });

  it("rejects guild slash commands when owner restrictions are configured and the sender is not allowlisted", async () => {
    await runUnauthorizedCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = {};
        cfg.channels!.discord!.allowFrom = ["user:123456789012345678"];
      },
    });
  });

  it("rejects guild slash commands when commands.ownerAllowFrom fails even if the channel-level native gate allowed the command", async () => {
    await runUnauthorizedCommand({
      userId: "999999999999999999",
      mutateConfig: (cfg) => {
        cfg.commands = { ownerAllowFrom: ["discord:123456789012345678"] };
      },
    });
  });

  it("authorizes guild slash commands when commands.allowFrom.discord contains a matching guild: entry", async () => {
    await runAuthorizedCommand({
      userId: "999999999999999999",
      commands: { allowFrom: { discord: ["guild:345678901234567890"] } },
    });
  });

  it("rejects guild slash commands when commands.allowFrom.discord has a guild: entry that does not match", async () => {
    await runUnauthorizedCommand({
      userId: "999999999999999999",
      commands: { allowFrom: { discord: ["guild:000000000000000000"] } },
    });
  });

  it("uses the root discord maxLinesPerMessage when runtime discordConfig omits it", async () => {
    const longReply = Array.from({ length: 20 }, (_value, index) => `Line ${index + 1}`).join("\n");
    const { interaction } = await runGuildSlashCommand({
      mutateConfig: (cfg) => {
        cfg.channels!.discord!.maxLinesPerMessage = 120;
      },
      runtimeDiscordConfig: createConfig().channels!.discord,
    });

    await firstDispatchReplyCall().dispatcherOptions.deliver(
      { text: longReply },
      { kind: "final" },
    );

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
});

installDiscordIngressTestRuntime();
