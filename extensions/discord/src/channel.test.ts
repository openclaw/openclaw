import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";
import { setDiscordRuntime } from "./runtime.js";

describe("discordPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageDiscord", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:123",
      "hi",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m1" });
  });

  it("uses threadId as target for sendText", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m2" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      text: "hello",
      threadId: "456",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:456",
      "hello",
      expect.objectContaining({ accountId: "work" }),
    );
  });

  it("uses threadId as target for sendMedia", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m3" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      text: "photo",
      mediaUrl: "https://example.com/a.png",
      threadId: "456",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:456",
      "photo",
      expect.objectContaining({ mediaUrl: "https://example.com/a.png", accountId: "work" }),
    );
  });

  it("uses threadId as target for sendPoll", async () => {
    const sendPollDiscord = vi.fn(async () => ({ messageId: "p1", channelId: "456" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendPollDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendPoll!({
      cfg: {} as OpenClawConfig,
      to: "channel:123",
      poll: { question: "Q", options: ["A", "B"] },
      threadId: "456",
      accountId: "work",
    });

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:456",
      { question: "Q", options: ["A", "B"] },
      expect.objectContaining({ accountId: "work" }),
    );
  });
});
