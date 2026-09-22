import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType } from "discord-api-types/v10";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discordPlugin } from "../channel.js";
import type { CommandInteraction } from "../internal/discord.js";
import { setDiscordRuntime } from "../runtime.js";
import { createDiscordNativeCommand } from "./native-command.js";
import { createMockCommandInteraction } from "./native-command.test-helpers.js";
import { createNoopThreadBindingManager } from "./thread-bindings.manager.js";

const directories: string[] = [];
const userId = "100000000000000003";
const channelId = "100000000000000001";
const guildId = "100000000000000002";
const otherChannelId = "100000000000000005";
const sessionId = "existing-channel-session";

afterEach(async () => {
  clearRuntimeConfigSnapshot();
  setActivePluginRegistry(createTestRegistry());
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function runNativeCommand(params: {
  commandName: string;
  guildChannels: Record<string, { enabled?: boolean }>;
  configuredBinding?: boolean;
  label: string;
}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "discord-guild-guards-"));
  directories.push(home);
  const storePath = path.join(home, "sessions.json");
  const sessionKey = `agent:main:discord:channel:${channelId}`;
  const scope = { agentId: "main", storePath, sessionKey };
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: home } },
    session: { store: storePath },
    commands: { allowFrom: { discord: [`user:${userId}`] } },
    ...(params.configuredBinding
      ? {
          bindings: [
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
          ],
        }
      : {}),
    channels: {
      discord: {
        commands: { native: true },
        guilds: { [guildId]: { channels: params.guildChannels } },
      },
    },
  } as OpenClawConfig;
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
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
    interactionId: params.label,
  });
  const command = createDiscordNativeCommand({
    command: { name: params.commandName, description: "Guild guard probe.", acceptsArgs: true },
    cfg,
    discordConfig: cfg.channels!.discord!,
    accountId: "default",
    sessionPrefix: "discord:slash",
    ephemeralDefault: true,
    threadBindings: createNoopThreadBindingManager("default"),
  });
  await command.run(interaction as unknown as CommandInteraction);
  return {
    entry: getSessionEntry(scope),
    replies: [...interaction.reply.mock.calls, ...interaction.followUp.mock.calls].map(
      ([payload]) => payload?.content,
    ),
  };
}

describe("discord native command guild guards", () => {
  beforeEach(() => {
    setDiscordRuntime(createPluginRuntimeMock());
  });

  it.each(["reset", "new"] as const)(
    "refuses /%s in a disabled guild channel with no configured binding",
    async (commandName) => {
      const result = await runNativeCommand({
        commandName,
        guildChannels: { [channelId]: { enabled: false } },
        label: `disabled-${commandName}`,
      });
      expect(result.replies).toEqual(["This channel is disabled."]);
      expect(result.entry?.lifecycleRevision).toBe("before-reset");
    },
  );

  it.each(["reset", "new"] as const)(
    "refuses /%s in a not-allowed guild channel with no configured binding",
    async (commandName) => {
      const result = await runNativeCommand({
        commandName,
        guildChannels: { [otherChannelId]: { enabled: true } },
        label: `notallowed-${commandName}`,
      });
      expect(result.replies).toEqual(["This channel is not allowed."]);
      expect(result.entry?.lifecycleRevision).toBe("before-reset");
    },
  );

  it("refuses /status in a disabled guild channel", async () => {
    const result = await runNativeCommand({
      commandName: "status",
      guildChannels: { [channelId]: { enabled: false } },
      label: "disabled-status",
    });
    expect(result.replies).toEqual(["This channel is disabled."]);
  });

  it.each(["reset", "new"] as const)(
    "still bypasses the guards for /%s when a configured binding owns the channel",
    async (commandName) => {
      const result = await runNativeCommand({
        commandName,
        guildChannels: { [channelId]: { enabled: false } },
        configuredBinding: true,
        label: `bound-${commandName}`,
      });
      expect(result.replies).not.toContain("This channel is disabled.");
      expect(result.replies).not.toContain("This channel is not allowed.");
      expect(result.replies.length).toBeGreaterThan(0);
    },
  );

  it.each(["reset", "new"] as const)(
    "still runs /%s in an enabled guild channel with no configured binding",
    async (commandName) => {
      const result = await runNativeCommand({
        commandName,
        guildChannels: { [channelId]: { enabled: true } },
        label: `enabled-${commandName}`,
      });
      expect(result.replies).toEqual([
        commandName === "new" ? "✅ New session started." : "✅ Session reset.",
      ]);
      expect(result.entry?.lifecycleRevision).not.toBe("before-reset");
    },
  );
});
