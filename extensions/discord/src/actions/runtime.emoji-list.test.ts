import { ChannelType, type RESTGetAPIGuildEmojisResult } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tryHandleDiscordMessageActionGuildAdmin } from "./handle-action.guild-admin.js";
import { handleDiscordMessageAction } from "./handle-action.js";

const { fetchChannelInfoDiscord, listGuildEmojisDiscord } = vi.hoisted(() => ({
  fetchChannelInfoDiscord: vi.fn(async (channelId: string) => ({
    id: channelId,
    type: ChannelType.GuildText,
    guild_id: "G1",
  })),
  listGuildEmojisDiscord: vi.fn(async (): Promise<RESTGetAPIGuildEmojisResult> => []),
}));

vi.mock("../send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.js")>()),
  fetchChannelInfoDiscord,
  listGuildEmojisDiscord,
}));

function discordCfg(
  discord: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>,
): OpenClawConfig {
  return { channels: { discord } };
}
const DISCORD_TEST_CFG = discordCfg({ token: "token", groupPolicy: "open" });

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Discord emoji-list message action", () => {
  it.each([
    {
      label: "resolves the guild from the current channel",
      params: {},
      currentChannelId: "channel:123",
      expectedGuildId: "current-guild",
      resolvesChannel: true,
    },
    {
      label: "uses an explicit guild from a DM",
      params: { guildId: "explicit-guild" },
      currentChannelId: "user:456",
      expectedGuildId: "explicit-guild",
      resolvesChannel: false,
    },
    ...["channelId", "to"].map((key) => ({
      label: `uses an explicit ${key} from a DM`,
      params: { [key]: "channel:123" },
      currentChannelId: "user:456",
      expectedGuildId: "current-guild",
      resolvesChannel: true,
    })),
  ])(
    "$label for emoji-list",
    async ({ params, currentChannelId, expectedGuildId, resolvesChannel }) => {
      if (resolvesChannel) {
        fetchChannelInfoDiscord.mockResolvedValueOnce({
          id: "123",
          type: ChannelType.GuildText,
          guild_id: "current-guild",
        });
      }

      const result = await handleDiscordMessageAction({
        action: "emoji-list",
        params,
        cfg: DISCORD_TEST_CFG,
        toolContext: { currentChannelProvider: "discord", currentChannelId },
      });

      expect(result.details).toEqual({ ok: true, emojis: [] });
      expect(listGuildEmojisDiscord).toHaveBeenCalledWith(expectedGuildId, {
        cfg: DISCORD_TEST_CFG,
      });
      expect(fetchChannelInfoDiscord).toHaveBeenCalledTimes(resolvesChannel ? 1 : 0);
    },
  );

  it("supports resolver-only callers of the exported guild-admin helper", async () => {
    const result = await tryHandleDiscordMessageActionGuildAdmin({
      ctx: { action: "emoji-list", params: {}, cfg: DISCORD_TEST_CFG },
      resolveChannelId: () => "123",
      actionOptions: {},
    });

    expect(result?.details).toEqual({ ok: true, emojis: [] });
    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("123", { cfg: DISCORD_TEST_CFG });
    expect(listGuildEmojisDiscord).toHaveBeenCalledWith("G1", { cfg: DISCORD_TEST_CFG });
  });

  it.each(["user:456", "discord:user:456", undefined])(
    "requests a guild or server channel for emoji-list with current target %s",
    async (currentChannelId) => {
      await expect(
        handleDiscordMessageAction({
          action: "emoji-list",
          params: {},
          cfg: DISCORD_TEST_CFG,
          toolContext: { currentChannelProvider: "discord", currentChannelId },
        }),
      ).rejects.toThrow("Discord emoji listing requires guildId or a server channel.");
      expect(fetchChannelInfoDiscord).not.toHaveBeenCalled();
      expect(listGuildEmojisDiscord).not.toHaveBeenCalled();
    },
  );

  it("keeps emoji-list reaction gating when the current target is a DM", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "emoji-list",
        params: {},
        cfg: discordCfg({ token: "token", actions: { reactions: false } }),
        toolContext: { currentChannelProvider: "discord", currentChannelId: "user:456" },
      }),
    ).rejects.toThrow("Discord reactions are disabled.");
    expect(fetchChannelInfoDiscord).not.toHaveBeenCalled();
    expect(listGuildEmojisDiscord).not.toHaveBeenCalled();
  });
});
