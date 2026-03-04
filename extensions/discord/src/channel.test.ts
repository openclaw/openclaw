import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { discordPlugin } from "./channel.js";
import { setDiscordRuntime } from "./runtime.js";

function stubRuntime() {
  const sendMessageDiscord = vi.fn(async () => ({ messageId: "m1" }));
  const sendPollDiscord = vi.fn(async () => ({ messageId: "p1", channelId: "789" }));
  setDiscordRuntime({
    channel: {
      discord: { sendMessageDiscord, sendPollDiscord },
    },
  } as unknown as PluginRuntime);
  return { sendMessageDiscord, sendPollDiscord };
}

describe("discordPlugin outbound", () => {
  it("forwards mediaLocalRoots to sendMessageDiscord", async () => {
    const { sendMessageDiscord } = stubRuntime();

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

  it("sendText resolves threadId into target", async () => {
    const { sendMessageDiscord } = stubRuntime();

    await discordPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "channel:100",
      text: "thread msg",
      threadId: "555",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:555",
      "thread msg",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("sendText uses original target when threadId is absent", async () => {
    const { sendMessageDiscord } = stubRuntime();

    await discordPlugin.outbound!.sendText!({
      cfg: {} as OpenClawConfig,
      to: "channel:100",
      text: "no thread",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:100",
      "no thread",
      expect.objectContaining({ verbose: false }),
    );
  });

  it("sendMedia resolves threadId into target", async () => {
    const { sendMessageDiscord } = stubRuntime();

    await discordPlugin.outbound!.sendMedia!({
      cfg: {} as OpenClawConfig,
      to: "channel:200",
      text: "media in thread",
      mediaUrl: "/img.png",
      threadId: "777",
    });

    expect(sendMessageDiscord).toHaveBeenCalledWith(
      "channel:777",
      "media in thread",
      expect.objectContaining({ mediaUrl: "/img.png" }),
    );
  });

  it("sendPoll resolves threadId into target", async () => {
    const { sendPollDiscord } = stubRuntime();

    await discordPlugin.outbound!.sendPoll!({
      cfg: {} as OpenClawConfig,
      to: "channel:300",
      poll: { question: "Q?" } as never,
      threadId: "999",
    });

    expect(sendPollDiscord).toHaveBeenCalledWith(
      "channel:999",
      expect.objectContaining({ question: "Q?" }),
      expect.any(Object),
    );
  });
});
