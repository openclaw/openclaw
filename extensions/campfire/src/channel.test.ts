import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCampfirePlugin } from "./channel.js";

describe("campfire channel plugin", () => {
  it("sends outbound text using account chunk settings", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({
      sendText,
      now: () => 123,
    });

    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          textChunkLimit: 2500,
        },
      },
    } as OpenClawConfig;

    const result = await plugin.outbound?.sendText?.({
      cfg,
      to: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      text: "Hello world",
      accountId: "default",
    });

    expect(sendText).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      "Hello world",
      2500,
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "campfire",
        chatId: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
        messageId: "campfire-123",
      }),
    );
  });

  it("rejects outbound targets outside the configured base URL", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({ sendText });
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
        },
      },
    } as OpenClawConfig;

    await expect(
      plugin.outbound?.sendText?.({
        cfg,
        to: "https://attacker.example.net/rooms/7/key/messages",
        text: "Hello world",
        accountId: "default",
      }),
    ).rejects.toThrow("must match channels.campfire.baseUrl");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects outbound targets outside the configured workspace path", async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const plugin = createCampfirePlugin({ sendText });
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://3.basecamp.com/1234567",
          botKey: "42-AbCdEf",
        },
      },
    } as OpenClawConfig;

    await expect(
      plugin.outbound?.sendText?.({
        cfg,
        to: "https://3.basecamp.com/7654321/buckets/7/chats/88/messages/99",
        text: "Hello world",
        accountId: "default",
      }),
    ).rejects.toThrow("must match channels.campfire.baseUrl");
    expect(sendText).not.toHaveBeenCalled();
  });
});
