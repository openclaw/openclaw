import { ChannelType } from "discord-api-types/v10";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
  useBundledProviderPolicyArtifactsForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  getSessionEntry,
  loadTranscriptEventsSync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discordPlugin } from "../channel.js";
import { setDiscordRuntime } from "../runtime.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

let state: OpenClawTestState;
const userId = "100000000000000003";
const channelId = "100000000000000001";
const guildId = "100000000000000002";
const sessionId = "existing-channel-session";

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "discord-native-reset" });
  setDiscordRuntime(createPluginRuntimeMock());
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
});
afterEach(async () => {
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry());
  await state.cleanup();
});

async function runNativeCommand(params: {
  commandName: "new" | "reset";
  guildChannels?: Record<string, { enabled?: boolean }>;
  configuredBinding?: boolean;
  allowFrom?: string[];
}) {
  const scope = {
    agentId: "main",
    storePath: state.path("sessions.json"),
    sessionKey: `agent:main:discord:channel:${channelId}`,
  };
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    session: { store: scope.storePath },
    commands: { allowFrom: { discord: params.allowFrom ?? [`user:${userId}`] } },
    bindings: params.configuredBinding
      ? [
          {
            type: "acp",
            agentId: "main",
            match: {
              channel: "discord",
              accountId: "default",
              peer: { kind: "channel", id: channelId },
            },
            acp: { backend: "acpx" },
          },
        ]
      : undefined,
    channels: {
      discord: {
        commands: { native: true },
        guilds: {
          [guildId]: { channels: params.guildChannels ?? { [channelId]: { enabled: true } } },
        },
      },
    },
  };
  await upsertSessionEntry({
    ...scope,
    entry: {
      sessionId,
      lifecycleRevision: "before-reset",
      updatedAt: Date.now(),
      totalTokens: 100,
    },
  });
  setRuntimeConfigSnapshot(cfg);
  const interaction = createMockCommandInteraction({
    channelType: ChannelType.GuildText,
    channelId,
    guildId,
    userId,
    interactionId: params.commandName,
  });
  const command = createDiscordNativeCommand({
    command: { name: params.commandName, description: "Reset the session.", acceptsArgs: true },
    cfg,
    discordConfig: cfg.channels!.discord!,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
  await command.run(interaction);
  return {
    entry: getSessionEntry(scope),
    events: loadTranscriptEventsSync({ ...scope, sessionId }),
    replies: [...interaction.reply.mock.calls, ...interaction.followUp.mock.calls].map(
      ([payload]) => payload?.content,
    ),
  };
}

describe("Discord native reset admission and persistence", () => {
  it("persists and acknowledges /new", async () => {
    const result = await runNativeCommand({ commandName: "new" });
    expect(result.entry?.sessionId).toBe(sessionId);
    expect(result.entry?.lifecycleRevision).toBeTruthy();
    expect(result.entry?.lifecycleRevision).not.toBe("before-reset");
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "reset", reason: "new" })]),
    );
    expect(result.replies).toEqual(["✅ New session started."]);
  });

  const blockedChannels: Array<{
    commandName: "new" | "reset";
    guildChannels: Record<string, { enabled?: boolean }>;
    reply: string;
  }> = [
    {
      commandName: "reset",
      guildChannels: { [channelId]: { enabled: false } },
      reply: "This channel is disabled.",
    },
    {
      commandName: "new",
      guildChannels: { other: { enabled: true } },
      reply: "This channel is not allowed.",
    },
  ];
  it.each(blockedChannels)(
    "denies /$commandName in a blocked guild channel",
    async ({ reply, ...params }) => {
      const result = await runNativeCommand(params);
      expect(result.replies).toEqual([reply]);
      expect(result.entry?.lifecycleRevision).toBe("before-reset");
    },
  );

  it("preserves the session when the command allowlist is empty", async () => {
    const result = await runNativeCommand({ commandName: "reset", allowFrom: [] });
    expect(result.entry?.lifecycleRevision).toBe("before-reset");
    expect(result.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "reset" })]),
    );
  });

  it("lets the configured binding own reset admission", async () => {
    const result = await runNativeCommand({
      commandName: "reset",
      guildChannels: { [channelId]: { enabled: false } },
      configuredBinding: true,
    });
    expect(result.replies).not.toContain("This channel is disabled.");
    expect(result.replies).not.toContain("This channel is not allowed.");
    expect(result.replies.length).toBeGreaterThan(0);
  });
});

useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
