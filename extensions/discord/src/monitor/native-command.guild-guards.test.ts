import { ChannelType } from "discord-api-types/v10";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import * as plugins from "openclaw/plugin-sdk/plugin-test-runtime";
import * as snapshots from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessions from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, expect, it } from "vitest";
import { discordPlugin } from "../channel.js";
import { setDiscordRuntime } from "../runtime.js";
import { nativeCommandContext } from "./native-command.dispatch.test-support.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";

let state: OpenClawTestState;
const userId = "100000000000000003";
const channelId = "100000000000000001";
const guildId = "100000000000000002";
const sessionId = "existing-channel-session";
const acpBinding: NonNullable<OpenClawConfig["bindings"]>[number] = {
  type: "acp",
  agentId: "main",
  match: { channel: "discord", accountId: "default", peer: { kind: "channel", id: channelId } },
  acp: { backend: "acpx" },
};

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "discord-native-reset" });
  setDiscordRuntime(createPluginRuntimeMock());
  plugins.setActivePluginRegistry(
    plugins.createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
});
afterEach(async () => {
  snapshots.clearRuntimeConfigSnapshot();
  plugins.setActivePluginRegistry(plugins.createTestRegistry());
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
  const channels = params.guildChannels ?? { [channelId]: { enabled: true } };
  const guilds = { [guildId]: { channels } };
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir } },
    session: { store: scope.storePath },
    commands: { allowFrom: { discord: params.allowFrom ?? [`user:${userId}`] } },
    bindings: params.configuredBinding ? [acpBinding] : undefined,
    channels: { discord: { commands: { native: true }, guilds } },
  };
  await sessions.upsertSessionEntry({
    ...scope,
    entry: {
      sessionId,
      lifecycleRevision: "before-reset",
      updatedAt: Date.now(),
      totalTokens: 100,
    },
  });
  snapshots.setRuntimeConfigSnapshot(cfg);
  const interaction = createMockCommandInteraction({
    channelType: ChannelType.GuildText,
    channelId,
    guildId,
    userId,
  });
  await createDiscordNativeCommand({
    command: { name: params.commandName, description: "Reset the session.", acceptsArgs: true },
    ...nativeCommandContext(cfg),
    ephemeralDefault: true,
  }).run(interaction);
  return {
    entry: sessions.getSessionEntry(scope),
    events: sessions.loadTranscriptEventsSync({ ...scope, sessionId }),
    replies: [...interaction.reply.mock.calls, ...interaction.followUp.mock.calls].map(
      ([payload]) => payload?.content,
    ),
  };
}

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

const emptyAllowFrom: string[] = [];
it.each([
  ["reset", { guildChannels: { [channelId]: { enabled: false } } }, "This channel is disabled."],
  ["new", { guildChannels: { other: { enabled: true } } }, "This channel is not allowed."],
  ["reset", { allowFrom: emptyAllowFrom }, undefined],
] as const)("preserves the session on denied /%s (%s)", async (commandName, params, reply) => {
  const result = await runNativeCommand({ commandName, ...params });
  expect(result.entry?.lifecycleRevision).toBe("before-reset");
  if (reply) {
    expect(result.replies).toEqual([reply]);
  } else {
    expect(result.events).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "reset" })]),
    );
  }
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
plugins.useBundledProviderPolicyArtifactsForTest(["openai", "anthropic"]);
