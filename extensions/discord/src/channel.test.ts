import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/discord";
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

  it("routes sendText to thread target when threadId is provided", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m-thread-text" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-1",
      text: "hello thread",
      threadId: "thread-1",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:thread-1",
      "hello thread",
      expect.objectContaining({ accountId: "work" }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m-thread-text" });
  });

  it("routes sendMedia to thread target when threadId is provided", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m-thread-media" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-2",
      text: "media thread",
      mediaUrl: "https://example.com/image.png",
      threadId: "thread-2",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:thread-2",
      "media thread",
      expect.objectContaining({
        mediaUrl: "https://example.com/image.png",
        accountId: "work",
      }),
    );
    expect(result).toMatchObject({ channel: "discord", messageId: "m-thread-media" });
  });

  it("routes sendPoll to thread target when threadId is provided", async () => {
    const sendPollDiscord = vi.fn(async () => ({ messageId: "m-thread-poll" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendPollDiscord,
        },
      },
    } as unknown as PluginRuntime);

    const result = await discordPlugin.outbound!.sendPoll!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-3",
      poll: {
        question: "Deploy?",
        options: ["yes", "no"],
      },
      threadId: "thread-3",
      accountId: "work",
    });

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:thread-3",
      expect.objectContaining({
        question: "Deploy?",
      }),
      expect.objectContaining({ accountId: "work" }),
    );
    expect(result).toMatchObject({ messageId: "m-thread-poll" });
  });
});
