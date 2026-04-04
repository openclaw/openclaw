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

  it("defaults content to empty string for upload-file without message", async () => {
    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        to: "channel:456",
        filePath: "https://example.com/file.png",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:456",
        content: "",
        mediaUrl: "https://example.com/file.png",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("forwards message content for upload-file when provided", async () => {
    await handleDiscordMessageAction({
      action: "upload-file",
      params: {
        to: "channel:456",
        filePath: "https://example.com/file.png",
        message: "Here is the file",
      },
      cfg: {
        channels: { discord: { token: "tok" } },
      } as OpenClawConfig,
    });

    expect(handleDiscordActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "sendMessage",
        to: "channel:456",
        content: "Here is the file",
        mediaUrl: "https://example.com/file.png",
      }),
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("rejects upload-file when no file path is provided", async () => {
    await expect(
      handleDiscordMessageAction({
        action: "upload-file",
        params: {
          to: "channel:456",
        },
        cfg: {
          channels: { discord: { token: "tok" } },
        } as OpenClawConfig,
      }),
    ).rejects.toThrow(/upload-file requires filePath, path, or media/);

    expect(handleDiscordActionMock).not.toHaveBeenCalled();
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
});
