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

const DISCORD_TEST_CFG = { channels: { discord: { accounts: { default: {} } } } };

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
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "discord",
        source: "test",
        plugin: {
          ...discordPlugin,
          outbound: { ...discordPlugin.outbound, afterDeliverPayload },
        },
      },
    ]),
  );
  try {
    const result = await sendDurableMessageBatch({
      cfg: DISCORD_TEST_CFG,
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
    expect(result.status).toBe("sent");
    if (result.status !== "sent") {
      throw new Error("expected durable Discord forum batch to send");
    }
    return {
      postPaths: loopback.requests
        .filter((request) => request.method === "POST")
        .map((request) => request.path),
      deliveredThreadIds: afterDeliverPayload.mock.calls.map(
        ([ctx]) => (ctx as { target?: { threadId?: unknown } }).target?.threadId,
      ),
      receipt: result.receipt,
    };
  } finally {
    await loopback.close();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  }
}

describe("durable Discord forum batches", () => {
  it.each<ChannelType.GuildForum | ChannelType.GuildMedia>([
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
  ])("keeps a payload batch in one created %s thread", async (parentType) => {
    const { deliveredThreadIds, postPaths, receipt } = await runDurableDiscordForumBatch({
      parentType,
    });

    expect(postPaths).toEqual([
      `/v10${Routes.threads("700")}`,
      `/v10${Routes.channelMessages("701")}`,
      `/v10${Routes.channelMessages("701")}`,
    ]);
    expect(deliveredThreadIds).toEqual(["701", "701"]);
    expect(receipt).toMatchObject({
      threadId: "701",
      platformMessageIds: ["starter-1", "message-1", "message-2"],
    });
  });

  it("keeps an explicit thread authoritative for the full payload batch", async () => {
    const { deliveredThreadIds, postPaths, receipt } = await runDurableDiscordForumBatch({
      parentType: ChannelType.GuildForum,
      threadId: "900",
    });

    expect(postPaths).toEqual([
      `/v10${Routes.channelMessages("900")}`,
      `/v10${Routes.channelMessages("900")}`,
      `/v10${Routes.channelMessages("900")}`,
    ]);
    expect(deliveredThreadIds).toEqual(["900", "900"]);
    expect(receipt).toMatchObject({
      threadId: "900",
      platformMessageIds: ["message-1", "message-2", "message-3"],
    });
  });
});
