import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeModule = await import("./runtime.js");
const handleDiscordActionMock = vi
  .spyOn(runtimeModule, "handleDiscordAction")
  .mockResolvedValue({ content: [], details: { ok: true } });
const { handleDiscordMessageAction } = await import("./handle-action.js");

describe("handleDiscordMessageAction", () => {
  beforeEach(() => {
    handleDiscordActionMock.mockClear();
  });

  it("uses trusted requesterSenderId for moderation and ignores params senderUserId", async () => {
    await handleDiscordMessageAction({
      action: "timeout",
      params: {
        guildId: "guild-1",
        userId: "user-2",
        durationMin: 5,
        senderUserId: "spoofed-admin-id",
      },
      cfg: {
        channels: { discord: { token: "tok", actions: { moderation: true } } },
      } as OpenClawConfig,
      requesterSenderId: "trusted-sender-id",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "timeout",
        guildId: "guild-1",
        userId: "user-2",
        durationMinutes: 5,
        senderUserId: "trusted-sender-id",
      }),
      expect.objectContaining({
        channels: {
          discord: expect.objectContaining({
            token: "tok",
          }),
        },
      }),
    );
  });

  it("falls back to toolContext.currentMessageId for reactions", async () => {
    await handleDiscordMessageAction({
      action: "react",
      params: {
        channelId: "123",
        emoji: "ok",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
      toolContext: { currentMessageId: "9001" },
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "react",
        channelId: "123",
        messageId: "9001",
        emoji: "ok",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects reactions when no message id source is available", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "react",
        params: {
          channelId: "123",
          emoji: "ok",
        },
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
      }),
    ).rejects.toThrow(/messageId required/i);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
  });

  it("forwards appliedTags for channel-edit actions", async () => {
    await handleDiscordMessageAction({
      action: "channel-edit",
      params: {
        channelId: "thread-123",
        appliedTags: ["tag-1", "tag-2"],
      },
      cfg: {
        channels: { discord: { token: "tok", actions: { channels: true } } },
      } as OpenClawConfig,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channelEdit",
        channelId: "thread-123",
        appliedTags: ["tag-1", "tag-2"],
      }),
      expect.any(Object),
    );
  });

  it("forwards empty appliedTags array for clearing forum tags", async () => {
    await handleDiscordMessageAction({
      action: "channel-edit",
      params: {
        channelId: "thread-456",
        appliedTags: [],
      },
      cfg: {
        channels: { discord: { token: "tok", actions: { channels: true } } },
      } as OpenClawConfig,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "channelEdit",
        channelId: "thread-456",
        appliedTags: [],
      }),
      expect.any(Object),
    );
  });
});
