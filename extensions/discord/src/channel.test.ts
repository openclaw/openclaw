import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/discord";
import { describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";
import { setDiscordRuntime } from "./runtime.js";

describe("discordPlugin outbound", () => {
  it("routes text sends to thread targets when threadId is provided", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m-thread" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-1",
      text: "hello",
      threadId: "thread-1",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:thread-1",
      "hello",
      expect.objectContaining({
        accountId: "work",
      }),
    );
  });

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

  it("routes media sends to thread targets when threadId is provided", async () => {
    const sendMessageDiscord = vi.fn(async () => ({ messageId: "m-media" }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-1",
      text: "hi",
      mediaUrl: "/tmp/image.png",
      threadId: "thread-1",
      accountId: "work",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:thread-1",
      "hi",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        accountId: "work",
      }),
    );
  });

  it("routes poll sends to thread targets when threadId is provided", async () => {
    const sendPollDiscord = vi.fn(async () => ({
      ok: true,
      channel: "discord",
      pollId: "poll-1",
    }));
    setDiscordRuntime({
      channel: {
        discord: {
          sendMessageDiscord: vi.fn(),
          sendPollDiscord,
        },
      },
    } as unknown as PluginRuntime);

    await discordPlugin.outbound!.sendPoll!({
      cfg: {} as OpenClawConfig,
      to: "channel:parent-1",
      poll: { question: "Best snack?", options: ["banana", "apple"] },
      threadId: "thread-1",
      accountId: "work",
    });

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:thread-1",
      { question: "Best snack?", options: ["banana", "apple"] },
      expect.objectContaining({
        accountId: "work",
      }),
    );
  });
});
