import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
}));

import { nextcloudTalkPlugin } from "./channel.js";

describe("nextcloudTalkPlugin outbound cfg forwarding", () => {
  beforeEach(() => {
    sendMessageNextcloudTalkMock.mockReset();
    sendMessageNextcloudTalkMock.mockResolvedValue({
      messageId: "m-1",
      roomToken: "room-1",
    });
  });

  it("forwards cfg to sendText adapter path", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          baseUrl: "https://cloud.example.com",
          botSecret: "resolved-secret",
        },
      },
    };

    await nextcloudTalkPlugin.outbound?.sendText?.({
      cfg,
      to: "room:room-1",
      text: "hello",
      accountId: "default",
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledWith(
      "room:room-1",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
      }),
    );
  });

  it("forwards cfg to sendMedia adapter path", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        "nextcloud-talk": {
          enabled: true,
          baseUrl: "https://cloud.example.com",
          botSecret: "resolved-secret",
        },
      },
    };

    await nextcloudTalkPlugin.outbound?.sendMedia?.({
      cfg,
      to: "room:room-1",
      text: "hello",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledWith(
      "room:room-1",
      expect.stringContaining("Attachment: https://example.com/image.png"),
      expect.objectContaining({
        cfg,
        accountId: "default",
      }),
    );
  });
});
