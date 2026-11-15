import { ChannelType } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, expect, it, vi } from "vitest";
import {
  auditDiscordChannelPermissionsWithFetcher as auditPermissions,
  collectDiscordAuditChannelIdsForAccount as collect,
} from "./audit-core.js";

const fetchPermissions = vi.fn();
function legacyConfig(channels: Record<string, { allow: boolean }>): OpenClawConfig {
  return {
    channels: { discord: { guilds: { "123": { channels } } } },
  } as unknown as OpenClawConfig;
}
function audit(channelIds: string[], cfg: OpenClawConfig) {
  return auditPermissions({
    cfg,
    token: "t",
    accountId: "default",
    channelIds,
    timeoutMs: 1000,
    fetchChannelPermissions: fetchPermissions,
  });
}
beforeEach(() => {
  fetchPermissions.mockReset();
});

it("audits disallowed numeric channels and counts unresolved keys", async () => {
  const cfg = legacyConfig({
    "111": { allow: true },
    general: { allow: true },
    "222": { allow: false },
  });
  const collected = collect({ guilds: cfg.channels?.discord?.guilds });
  expect(collected).toEqual({ channelIds: ["111", "222"], unresolvedChannels: 1 });
  fetchPermissions
    .mockResolvedValueOnce({ permissions: ["ViewChannel"] })
    .mockResolvedValueOnce({ permissions: ["ViewChannel", "SendMessages"] });
  const result = await audit(collected.channelIds, cfg);
  expect(result.ok).toBe(false);
  expect(result.channels).toHaveLength(2);
  expect(result.channels[0]?.channelId).toBe("111");
  expect(result.channels[0]?.missing).toContain("SendMessages");
});

it("does not count wildcard keys as unresolved channels", () => {
  const cfg = legacyConfig({ "111": { allow: true }, "*": { allow: true } });
  expect(collect({ guilds: cfg.channels?.discord?.guilds })).toEqual({
    channelIds: ["111"],
    unresolvedChannels: 0,
  });
});

it("includes voice auto-join channels", () => {
  const voice = {
    autoJoin: [
      { guildId: "123", channelId: "222" },
      { guildId: "123", channelId: "general" },
    ],
  };
  const guilds = { "123": { channels: { "111": { enabled: true } } } };
  expect(collect({ guilds, voice })).toEqual({ channelIds: ["111", "222"], unresolvedChannels: 1 });
});

const voiceMissing = ["Connect", "Speak", "ReadMessageHistory"];
const threadMissing = ["SendMessagesInThreads"];
it.each([
  [ChannelType.GuildVoice, "222", voiceMissing],
  [ChannelType.GuildStageVoice, "222", voiceMissing],
  [ChannelType.GuildNewsThread, "333", threadMissing],
  [ChannelType.GuildPublicThread, "333", threadMissing],
  [ChannelType.GuildPrivateThread, "333", threadMissing],
] as const)("requires channel-type permissions for %s", async (channelType, id, missing) => {
  fetchPermissions.mockResolvedValueOnce({
    permissions: ["ViewChannel", "SendMessages"],
    channelType,
  });
  const cfg = { channels: { discord: { enabled: true, token: "t" } } };
  const result = await audit([id], cfg);
  expect(result.ok).toBe(false);
  expect(result.channels[0]?.missing).toEqual(missing);
});
