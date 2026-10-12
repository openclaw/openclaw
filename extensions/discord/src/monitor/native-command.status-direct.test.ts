// Discord tests cover native command.status direct plugin behavior.
import { ChannelType } from "discord-api-types/v10";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntryAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type * as SessionTranscriptRuntime from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import * as nativeCommandRoute from "./native-command-route.js";
import { createMockCommandInteraction as createInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

const runtimeModuleMocks = vi.hoisted(() => ({
  dispatchReplyWithDispatcher: vi.fn(),
  loadWebMedia: vi.fn(),
  resolveDirectStatusReplyForSession: vi.fn(),
  useActualStatusResolver: false,
  recordDeliveredCommandExchange: vi.fn(async () => ({ ok: true })),
}));

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>(
    "openclaw/plugin-sdk/reply-dispatch-runtime",
  );
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) =>
      runtimeModuleMocks.dispatchReplyWithDispatcher(...args),
  };
});

vi.mock("openclaw/plugin-sdk/command-status-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/command-status-runtime")>();
  return {
    ...actual,
    resolveDirectStatusReplyForSession: (
      ...args: Parameters<typeof actual.resolveDirectStatusReplyForSession>
    ) =>
      runtimeModuleMocks.useActualStatusResolver
        ? actual.resolveDirectStatusReplyForSession(...args)
        : runtimeModuleMocks.resolveDirectStatusReplyForSession(...args),
  };
});

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionTranscriptRuntime>()),
  recordDeliveredCommandExchange: runtimeModuleMocks.recordDeliveredCommandExchange,
}));

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: (...args: unknown[]) => runtimeModuleMocks.loadWebMedia(...args),
}));

const dispatchChannelInboundTurnForTest: typeof channelInbound.dispatchChannelInboundTurn = async (
  plan,
) => {
  const dispatchResult = await runtimeModuleMocks.dispatchReplyWithDispatcher({
    ctx: plan.ctxPayload,
    cfg: plan.cfg,
    dispatcherOptions: {
      ...plan.dispatcherOptions,
      deliver: "deliver" in plan.delivery ? plan.delivery.deliver : undefined,
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

let createDiscordNativeCommand: typeof import("./native-command.js").createDiscordNativeCommand;

function createConfig(params?: { requireMention?: boolean }): OpenClawConfig {
  return {
    commands: {
      allowFrom: { discord: ["user:owner"] },
    },
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
              chan1: {
                allow: true,
                requireMention: params?.requireMention ?? true,
              },
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
    cfg,
    discordConfig: cfg.channels?.discord ?? {},
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
}

function setDefaultRouteState() {
  vi.spyOn(nativeCommandRoute, "resolveDiscordNativeInteractionRouteState").mockImplementation(
    (params) => ({
      effectiveRoute: {
        agentId: "main",
        channel: "discord",
        accountId: params.accountId ?? "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
        lastRoutePolicy: "session",
        matchedBy: "default",
      },
      boundSessionKey: undefined,
      configuredBinding: null,
    }),
  );
}

type MockWithCalls = { mock: { calls: unknown[][] } };

function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

function firstMockArg(mock: MockWithCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

function firstStatusCall(): {
  cfg: OpenClawConfig;
  sessionKey: string;
  channel: string;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
} {
  const call = firstMockArg(
    runtimeModuleMocks.resolveDirectStatusReplyForSession,
    "resolveDirectStatusReplyForSession",
  );
  return call as {
    cfg: OpenClawConfig;
    sessionKey: string;
    channel: string;
    isGroup: boolean;
    defaultGroupActivation: () => "always" | "mention";
  };
}

describe("discord native /status", () => {
  beforeAll(async () => {
    ({ createDiscordNativeCommand } = await import("./native-command.js"));
  });

  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    runtimeModuleMocks.useActualStatusResolver = false;
    runtimeModuleMocks.dispatchReplyWithDispatcher.mockResolvedValue({
      counts: {
        final: 0,
        block: 0,
        tool: 0,
      },
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
    setDefaultRouteState();
  });

  it("delivers an embed-only direct status reply without reporting it unavailable", async () => {
    const embeds = [{ title: "Status", description: "All systems operational" }];
    runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue({
      channelData: { discord: { embeds } },
    });
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledOnce();
    expect(firstMockArg(interaction.followUp, "interaction.followUp")).toStrictEqual({
      embeds,
      ephemeral: true,
    });
  });

  it("prioritizes direct status replies over matching plugin commands", async () => {
    const executePluginCommand = vi.fn(async () => ({ text: "plugin status" }));
    const cfg = createConfig();
    const command = await createStatusCommand(cfg, executePluginCommand);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.resolveDirectStatusReplyForSession).toHaveBeenCalledTimes(1);
    expect(executePluginCommand).not.toHaveBeenCalled();
    expect(runtimeModuleMocks.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledTimes(1);
    expect(firstMockArg(interaction.followUp, "interaction.followUp")).toStrictEqual({
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

  it.each([
    { profileCase: "valid", profileId: "openai:fixture", profileAvailable: true },
    { profileCase: "unavailable", profileId: "openai:missing", profileAvailable: false },
  ])(
    "renders native /status with a saved $profileCase automatic auth profile without changing persisted selection",
    async ({ profileCase, profileId, profileAvailable }) => {
      runtimeModuleMocks.useActualStatusResolver = true;
      await withOpenClawTestState(
        { label: `discord-status-saved-profile-${profileCase}` },
        async (state) => {
          const sessionKey = "agent:main:main";
          const cfg = {
            ...createConfig(),
            plugins: { enabled: false },
            session: { mainKey: "main" },
            agents: {
              entries: { main: {} },
              defaults: { model: "openai/gpt-4o", thinkingDefault: "off", reasoningDefault: "off" },
            },
          } as OpenClawConfig;
          const entry = {
            sessionId: `discord-status-session-${profileCase}`,
            updatedAt: Date.now(),
            modelProvider: "openai",
            model: "gpt-4o",
            authProfileOverride: profileId,
            authProfileOverrideSource: "auto" as const,
          };

          await state.writeConfig(cfg);
          setRuntimeConfigSnapshot(cfg, cfg);
          await state.writeAuthProfiles({
            version: 1,
            profiles: profileAvailable
              ? {
                  "openai:fixture": {
                    type: "api_key",
                    provider: "openai",
                    key: "fixture-key",
                  },
                }
              : {},
          });
          const scope = { agentId: "main", env: state.env, sessionKey };
          await upsertSessionEntry({ ...scope, entry });

          const command = await createStatusCommand(cfg);
          const interaction = createInteraction();
          await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction);

          const payload = firstMockArg(interaction.followUp, "interaction.followUp") as {
            content?: unknown;
            embeds?: Array<{ description?: unknown }>;
          };
          const renderedText = [
            payload.content,
            ...(payload.embeds ?? []).map((embed) => embed.description),
          ]
            .filter((value): value is string => typeof value === "string")
            .join("\n");
          const persisted = await getSessionEntryAsync(scope);

          expect(renderedText).toContain("gpt-4o");
          expect(interaction.followUp).toHaveBeenCalledOnce();
          expect(persisted).toMatchObject(entry);
          console.log(
            "DISCORD_NATIVE_STATUS_PROOF",
            JSON.stringify({
              command: "/status",
              profileCase,
              renderedModelLine: renderedText.split("\n").find((line) => line.includes("gpt-4o")),
              savedProfile: persisted?.authProfileOverride,
              persistedSelectionUnchanged: true,
              transport: "local Discord interaction fixture",
            }),
          );
        },
      );
    },
  );

  it.each([false, true])(
    "records the unavailable status only after delivery (failed=%s)",
    async (failed) => {
      runtimeModuleMocks.resolveDirectStatusReplyForSession.mockResolvedValue(undefined);
      const command = await createStatusCommand(createConfig());
      const interaction = createInteraction();
      if (failed) {
        interaction.followUp.mockRejectedValueOnce({ discordCode: 10062 });
      }

      await command.run(interaction as never);

      expect(runtimeModuleMocks.recordDeliveredCommandExchange).toHaveBeenCalledTimes(
        failed ? 0 : 1,
      );
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
    const cfg = createConfig();
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction();

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    expect(runtimeModuleMocks.loadWebMedia).toHaveBeenCalledTimes(1);
    const [mediaUrl, mediaOptions] = firstMockCall(runtimeModuleMocks.loadWebMedia, "loadWebMedia");
    expect(mediaUrl).toBe("https://example.com/status.png");
    expect(Array.isArray((mediaOptions as { localRoots?: unknown } | undefined)?.localRoots)).toBe(
      true,
    );
    expect(interaction.followUp.mock.calls.length).toBeGreaterThan(1);
    const firstPayload = firstMockArg(interaction.followUp, "interaction.followUp") as
      | { ephemeral?: boolean; files?: Array<{ name?: string; data?: unknown }> }
      | undefined;
    expect(firstPayload?.ephemeral).toBe(true);
    expect(firstPayload?.files?.map((file) => file.name)).toEqual(["status.png"]);
    for (const [payload] of interaction.followUp.mock.calls) {
      expect((payload as { ephemeral?: boolean }).ephemeral).toBe(true);
    }
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  it("passes through the effective guild activation when requireMention is disabled", async () => {
    const cfg = createConfig({ requireMention: false });
    const command = await createStatusCommand(cfg);
    const interaction = createInteraction({
      channelType: ChannelType.GuildText,
      channelId: "chan1",
      guildId: "guild1",
      guildName: "Guild One",
    });

    await (command as { run: (interaction: unknown) => Promise<void> }).run(interaction as unknown);

    const statusCall = firstStatusCall();
    expect(statusCall.channel).toBe("discord");
    expect(statusCall.isGroup).toBe(true);
    expect(statusCall.defaultGroupActivation()).toBe("always");
  });
});

installDiscordIngressTestRuntime();
