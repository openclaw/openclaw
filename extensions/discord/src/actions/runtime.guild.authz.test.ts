import { PermissionFlagsBits } from "discord-api-types/v10";
import type { DiscordActionConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { discordGuildActionRuntime, handleDiscordGuildAction } from "./runtime.guild.js";

const originalDiscordGuildActionRuntime = { ...discordGuildActionRuntime };
const addRoleDiscord = vi.fn(async () => ({ ok: true }));
const createChannelDiscord = vi.fn(async () => ({ id: "channel-1" }));
const createScheduledEventDiscord = vi.fn(async () => ({ id: "event-1" }));
const deleteChannelDiscord = vi.fn(async () => ({ ok: true }));
const fetchChannelInfoDiscord = vi.fn(async () => ({ guild_id: "guild-1" }));
const hasAnyGuildPermissionDiscord = vi.fn(async () => false);
const uploadEmojiDiscord = vi.fn(async () => ({ id: "emoji-1" }));

const enableAllActions = (_key: keyof DiscordActionConfig, _defaultValue = true) => true;

describe("discord guild admin sender authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(discordGuildActionRuntime, originalDiscordGuildActionRuntime, {
      addRoleDiscord,
      createChannelDiscord,
      createScheduledEventDiscord,
      deleteChannelDiscord,
      fetchChannelInfoDiscord,
      hasAnyGuildPermissionDiscord,
      uploadEmojiDiscord,
    });
  });

  it("rejects roleAdd when sender lacks MANAGE_ROLES", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordGuildAction(
        "roleAdd",
        {
          guildId: "guild-1",
          userId: "user-1",
          roleId: "role-1",
          senderUserId: "sender-1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ManageRoles],
      undefined,
    );
    expect(addRoleDiscord).not.toHaveBeenCalled();
  });

  it("rejects channelDelete when sender lacks MANAGE_CHANNELS", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordGuildAction(
        "channelDelete",
        {
          channelId: "channel-1",
          senderUserId: "sender-1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(fetchChannelInfoDiscord).toHaveBeenCalledWith("channel-1");
    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ManageChannels],
      undefined,
    );
    expect(deleteChannelDiscord).not.toHaveBeenCalled();
  });

  it("forwards accountId for channelCreate permission checks and execution", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    createChannelDiscord.mockResolvedValueOnce({ id: "channel-1" });

    await handleDiscordGuildAction(
      "channelCreate",
      {
        guildId: "guild-1",
        name: "test-channel",
        senderUserId: "sender-1",
        accountId: "ops",
      },
      enableAllActions,
    );

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ManageChannels],
      { accountId: "ops" },
    );
    expect(createChannelDiscord).toHaveBeenCalledWith(
      {
        guildId: "guild-1",
        name: "test-channel",
        type: undefined,
        parentId: undefined,
        topic: undefined,
        position: undefined,
        nsfw: undefined,
      },
      { accountId: "ops" },
    );
  });

  it("allows emojiUpload when sender has guild-expression permissions", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(true);
    uploadEmojiDiscord.mockResolvedValueOnce({ id: "emoji-1" });

    await handleDiscordGuildAction(
      "emojiUpload",
      {
        guildId: "guild-1",
        name: "party",
        mediaUrl: "https://example.com/emoji.png",
        senderUserId: "sender-1",
      },
      enableAllActions,
    );

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [
        PermissionFlagsBits.ManageGuildExpressions,
        PermissionFlagsBits.CreateGuildExpressions,
        PermissionFlagsBits.ManageEmojisAndStickers,
      ],
      undefined,
    );
    expect(uploadEmojiDiscord).toHaveBeenCalledWith({
      guildId: "guild-1",
      name: "party",
      mediaUrl: "https://example.com/emoji.png",
      roleIds: undefined,
    });
  });

  it("rejects eventCreate when sender lacks event permissions", async () => {
    hasAnyGuildPermissionDiscord.mockResolvedValueOnce(false);

    await expect(
      handleDiscordGuildAction(
        "eventCreate",
        {
          guildId: "guild-1",
          name: "Town Hall",
          startTime: "2026-04-18T18:00:00.000Z",
          senderUserId: "sender-1",
        },
        enableAllActions,
      ),
    ).rejects.toThrow("required permissions");

    expect(hasAnyGuildPermissionDiscord).toHaveBeenCalledWith(
      "guild-1",
      "sender-1",
      [PermissionFlagsBits.ManageEvents, PermissionFlagsBits.CreateEvents],
      undefined,
    );
    expect(createScheduledEventDiscord).not.toHaveBeenCalled();
  });
});
