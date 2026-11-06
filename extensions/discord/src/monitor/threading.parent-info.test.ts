import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type Client } from "../internal/discord.js";
import { clearDiscordChannelInfoCacheForTest } from "./message-channel-info.test-support.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

const parent = { id: "parent-1", type: ChannelType.GuildText, name: "parent-name" };

function createClient(thread: { parentId?: string } | null = { parentId: "parent-1" }) {
  const fetchChannel = vi.fn(async (channelId: string) => {
    if (channelId === "thread-1" && thread) {
      return {
        id: "thread-1",
        type: ChannelType.PublicThread,
        name: "thread-name",
        parentId: thread.parentId,
      };
    }
    if (channelId === "parent-1" && (!thread || thread.parentId)) {
      return parent;
    }
    return null;
  });
  return { fetchChannel, client: { fetchChannel } as unknown as Client };
}

describe("resolveDiscordThreadParentInfo", () => {
  beforeEach(() => {
    clearDiscordChannelInfoCacheForTest();
  });

  it("falls back to fetched thread parentId when parentId is missing in payload", async () => {
    const { client, fetchChannel } = createClient();

    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: { id: "thread-1", parentId: undefined },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledWith("thread-1");
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result).toEqual(parent);
  });

  it("does not fetch thread info when parentId is already present", async () => {
    const { client, fetchChannel } = createClient(null);
    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: { id: "thread-1", parentId: "parent-1" },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("parent-1");
    expect(result).toEqual(parent);
  });

  it("returns empty parent info when fallback thread lookup has no parentId", async () => {
    const { client, fetchChannel } = createClient({});
    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: { id: "thread-1", parentId: undefined },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith("thread-1");
    expect(result).toStrictEqual({});
  });
});
