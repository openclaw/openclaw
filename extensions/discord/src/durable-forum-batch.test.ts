// Exercises the durable batch owner through Discord's real RequestClient boundary.
import { ChannelType, Routes } from "discord-api-types/v10";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDiscordLoopbackRest } from "./send.test-harness.js";

vi.mock("openclaw/plugin-sdk/web-media", async () => {
  const { discordWebMediaMockFactory } = await import("./send.test-harness.js");
  return discordWebMediaMockFactory();
});

let discordPlugin: typeof import("./channel.js").discordPlugin;
let sendMessageDiscord: typeof import("./send.js").sendMessageDiscord;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
  ({ sendMessageDiscord } = await import("./send.js"));
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/web-media");
});

async function runDurableDiscordForumBatch(params: {
  parentType: ChannelType.GuildForum | ChannelType.GuildMedia;
  threadId?: string;
}) {
  const parentId = "700";
  const createdThreadId = "701";
  let messageCount = 0;
  const loopback = await createDiscordLoopbackRest({
    respond: ({ method, path }) => {
      if (method === "GET") {
        const channelId = path?.split("/").at(-1);
        return {
          id: channelId,
          type: channelId === parentId ? params.parentType : ChannelType.PublicThread,
        };
      }
      if (method === "POST" && path?.endsWith(Routes.threads(parentId))) {
        return {
          id: createdThreadId,
          message: { id: "starter-1", channel_id: createdThreadId },
        };
      }
      const channelId = path?.split("/").at(-2);
      messageCount += 1;
      return { id: `message-${messageCount}`, channel_id: channelId };
    },
  });
  const afterDeliverPayload = vi.fn();
  const plugin = { ...discordPlugin, outbound: { ...discordPlugin.outbound, afterDeliverPayload } };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "discord", source: "test", plugin }]));
  try {
    const result = await sendDurableMessageBatch({
      cfg: { channels: { discord: { accounts: { default: {} } } } },
      channel: "discord",
      to: `channel:${parentId}`,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      payloads: [
        { text: "Forum starter" },
        {
          text: "Generated images",
          mediaUrls: ["https://example.com/first.jpg", "https://example.com/second.jpg"],
        },
      ],
      deps: {
        discord: async (...[target, text, options]: Parameters<typeof sendMessageDiscord>) =>
          await sendMessageDiscord(target, text, {
            ...options,
            rest: loopback.rest,
            token: "t",
          }),
      },
      skipQueue: true,
    });
    return {
      postPaths: loopback.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.path),
      deliveredThreadIds: afterDeliverPayload.mock.calls.map(
        ([ctx]) => (ctx as { target?: { threadId?: unknown } }).target?.threadId,
      ),
      result,
    };
  } finally {
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

describe("durable Discord forum batches", () => {
  it.each([
    [ChannelType.GuildForum, undefined],
    [ChannelType.GuildMedia, undefined],
    [ChannelType.GuildForum, "900"],
  ] as const)(
    "keeps the %s batch in its created or explicit thread %s",
    async (parentType, threadId) => {
      const actual = await runDurableDiscordForumBatch({ parentType, threadId });
      const target = threadId ?? "701";
      const messagePath = `/v10/channels/${target}/messages`;
      expect(actual).toMatchObject({
        postPaths: [threadId ? messagePath : "/v10/channels/700/threads", messagePath, messagePath],
        deliveredThreadIds: [target, target],
        result: {
          status: "sent",
          receipt: {
            threadId: target,
            platformMessageIds: threadId
              ? ["message-1", "message-2", "message-3"]
              : ["starter-1", "message-1", "message-2"],
          },
        },
      });
    },
  );
});
