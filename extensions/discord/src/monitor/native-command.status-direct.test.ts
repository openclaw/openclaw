import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import * as nativeCommandRoute from "./native-command-route.js";
import {
  forwardNativeCommand,
  nativeCommandContext,
} from "./native-command.dispatch.test-support.js";
import {
  createMockCommandInteraction as createInteraction,
  createRouteState,
} from "./native-command.test-helpers.js";

const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  loadWebMedia: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>(
    "openclaw/plugin-sdk/reply-dispatch-runtime",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: runtimeModuleMocks.dispatchReplyWithDispatcher,
  };
});

vi.mock("openclaw/plugin-sdk/command-status-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/command-status-runtime")>()),
  resolveDirectStatusReplyForSession: runtimeModuleMocks.resolveDirectStatusReplyForSession,
}));

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: runtimeModuleMocks.recordDeliveredCommandExchange,
}));

vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: runtimeModuleMocks.loadWebMedia,
}));

const dispatchChannelInboundTurnForTest = forwardNativeCommand(
  runtimeModuleMocks.dispatchReplyWithDispatcher,
  false,
);

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;

function createConfig(params?: { requireMention?: boolean }): OpenClawConfig {
  return {
    commands: { allowFrom: { discord: ["user:owner"] } },
    channels: {
      discord: {
        dm: { enabled: true },
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
        guilds: {
          guild1: {
            requireMention: true,
            channels: {
              chan1: { allow: true, requireMention: params?.requireMention ?? true },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function createStatusCommand(cfg: OpenClawConfig, pluginExecute?: ReturnType<typeof vi.fn>) {
  return createDiscordNativeCommand({
    command: {
      name: "status",
      description: "Status",
      acceptsArgs: false,
      ...(pluginExecute
        ? {
            requireAuth: true,
            prepareDispatch: () => ({
              kind: "plugin" as const,
              invocation: {
                runtime: { execute: pluginExecute },
                selection: Object.freeze({}),
              },
            }),
          }
        : {}),
    } as never,
    ...nativeCommandContext(cfg),
    ephemeralDefault: true,
  });
}

async function runStatus(
  cfg = createConfig(),
  interaction = createInteraction(),
  pluginExecute?: ReturnType<typeof vi.fn>,
) {
  const command = await createStatusCommand(cfg, pluginExecute);
  await command.run(interaction as never);
  return interaction;
}

beforeAll(async () => {
  ({ createDiscordNativeCommand } = await import("./native-command.js"));
});

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  vi.clearAllMocks();
  runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
    counts: { final: 0, block: 0, tool: 0 },
    queuedFinal: false,
  } as never);
  runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
    text: "status reply",
  });
  runtimeModuleMocks.loadWebMedia.mockResolvedValue({
    buffer: Buffer.from("image"),
    fileName: "status.png",
  });
  vi.spyOn(channelInbound, "dispatchChannelInboundTurn").mockImplementation(
    dispatchChannelInboundTurnForTest,
  );
  vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
    ({ accountId }) => createRouteState({ sessionKey: "agent:main:main", accountId }),
  );
});

it("delivers an embed-only direct status reply without reporting it unavailable", async () => {
  const embeds = [{ title: "Status", description: "All systems operational" }];
  runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
    channelData: { discord: { embeds } },
  });
  const interaction = await runStatus();

  expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
  expect(interaction.followUp).toHaveBeenCalledOnce();
  expect(interaction.followUp.mock.calls[0]?.[0]).toStrictEqual({
    embeds,
    ephemeral: true,
  });
});

it("prioritizes direct status replies over matching plugin commands", async () => {
  const executePluginCommand = vi.fn(async () => ({ text: "plugin status" }));
  const interaction = await runStatus(createConfig(), createInteraction(), executePluginCommand);

  expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenCalledTimes(1);
  expect(executePluginCommand).not.toHaveBeenCalled();
  expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
  expect(interaction.reply).not.toHaveBeenCalled();
  expect(interaction.followUp).toHaveBeenCalledOnce();
  expect(interaction.followUp.mock.calls[0]?.[0]).toStrictEqual({
    content: "status reply",
    ephemeral: true,
  });
  expect(runtimeModuleMocks.recordDeliveredCommandExchange).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionKey: "agent:main:main",
      commandText: "/status",
      replyText: "status reply",
      commandId: expect.stringMatching(/^discord:default:/),
    }),
  );
});

it.each([false, true])(
  "records the unavailable status only after delivery (failed=%s)",
  async (failed) => {
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue(undefined);
    const interaction = createInteraction();
    if (failed) {
      interaction.followUp.mockRejectedValueOnce({ discordCode: 10062 });
    }

    await runStatus(createConfig(), interaction);

    expect(runtimeModuleMocks.recordDeliveredCommandExchange).toHaveBeenCalledTimes(failed ? 0 : 1);
    if (!failed) {
      expect(runtimeModuleMocks.recordDeliveredCommandExchange).toHaveBeenCalledWith(
        expect.objectContaining({ commandText: "/status", replyText: "Status unavailable." }),
      );
    }
  },
);

it("keeps direct status media follow-up chunks ephemeral", async () => {
  runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
    text: `status image\n${"x".repeat(2200)}`,
    mediaUrls: ["https://example.com/status.png"],
  });
  const interaction = await runStatus();

  expect(runtimeModuleMocks.loadWebMedia).toHaveBeenCalledTimes(1);
  const [mediaUrl, mediaOptions] = runtimeModuleMocks.loadWebMedia.mock.calls[0]!;
  expect(mediaUrl).toBe("https://example.com/status.png");
  expect(Array.isArray((mediaOptions as { localRoots?: unknown } | undefined)?.localRoots)).toBe(
    true,
  );
  expect(interaction.followUp.mock.calls.length).toBeGreaterThan(1);
  const firstPayload = interaction.followUp.mock.calls[0]?.[0] as
    | { ephemeral?: boolean; files?: Array<{ name?: string; data?: unknown }> }
    | undefined;
  expect(firstPayload).toMatchObject({ ephemeral: true, files: [{ name: "status.png" }] });
  for (const [payload] of interaction.followUp.mock.calls) {
    expect((payload as { ephemeral?: boolean }).ephemeral).toBe(true);
  }
  expect(interaction.reply).not.toHaveBeenCalled();
});

it("passes through the effective guild activation when requireMention is disabled", async () => {
  await runStatus(
    createConfig({ requireMention: false }),
    createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild One",
    }),
  );
  const statusCall = runtimeModuleMocks.resolveDirectStatusReplyForSession.mock
    .calls[0]?.[0] as Parameters<
    typeof import("openclaw/plugin-sdk/command-status-runtime").resolveDirectStatusReplyForSession
  >[0];
  expect(statusCall).toMatchObject({ channel: "discord", isGroup: true });
  expect(statusCall.defaultGroupActivation?.()).toBe("always");
});

installDiscordIngressTestRuntime();
