// Discord tests cover threading.parent info plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { createPartialDiscordChannelWithThrowingGetters } from "../test-support/partial-channel.js";
import { resolveDiscordThreadParentInfo } from "./threading.js";

let idSequence = 0;
function nextTestId(prefix: string): string {
  return `${prefix}-${++idSequence}`;
}

describe("resolveDiscordThreadParentInfo", () => {
  it("falls back to fetched thread parentId when parentId is missing in payload", async () => {
    const threadId = nextTestId("thread");
    const parentId = nextTestId("parent");
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === threadId) {
        return {
          id: threadId,
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId,
        };
      }
      if (channelId === parentId) {
        return {
          id: parentId,
          type: ChannelType.GuildText,
          name: "parent-name",
        };
      }
      return null;
    });

    const client = {
      fetchChannel,
    } as unknown as import("../internal/discord.js").Client;

    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: {
        id: threadId,
        parentId: undefined,
      },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledWith(threadId);
    expect(fetchChannel).toHaveBeenCalledWith(parentId);
    expect(result).toEqual({
      id: parentId,
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });

  it("falls back to fetched thread parentId when partial channel getters throw", async () => {
    const threadId = nextTestId("thread");
    const parentId = nextTestId("parent");
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === threadId) {
        return {
          id: threadId,
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId,
        };
      }
      if (channelId === parentId) {
        return {
          id: parentId,
          type: ChannelType.GuildText,
          name: "parent-name",
        };
      }
      return null;
    });

    const client = { fetchChannel } as unknown as import("../internal/discord.js").Client;
    const threadChannel = createPartialDiscordChannelWithThrowingGetters(
      {
        id: threadId,
        parent: { id: "stale-parent", name: "stale-parent-name" },
      },
      ["parentId", "parent"],
    );

    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel,
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledWith(threadId);
    expect(fetchChannel).toHaveBeenCalledWith(parentId);
    expect(result).toEqual({
      id: parentId,
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });

  it("does not fetch thread info when parentId is already present", async () => {
    const threadId = nextTestId("thread");
    const parentId = nextTestId("parent");
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === parentId) {
        return {
          id: parentId,
          type: ChannelType.GuildText,
          name: "parent-name",
        };
      }
      return null;
    });

    const client = { fetchChannel } as unknown as import("../internal/discord.js").Client;
    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: {
        id: threadId,
        parentId,
      },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith(parentId);
    expect(result).toEqual({
      id: parentId,
      name: "parent-name",
      type: ChannelType.GuildText,
    });
  });

  it("returns empty parent info when fallback thread lookup has no parentId", async () => {
    const threadId = nextTestId("thread");
    const fetchChannel = vi.fn(async (channelId: string) => {
      if (channelId === threadId) {
        return {
          id: threadId,
          type: ChannelType.PublicThread,
          name: "thread-name",
          parentId: undefined,
        };
      }
      return null;
    });

    const client = { fetchChannel } as unknown as import("../internal/discord.js").Client;
    const result = await resolveDiscordThreadParentInfo({
      client,
      threadChannel: {
        id: threadId,
        parentId: undefined,
      },
      channelInfo: null,
    });

    expect(fetchChannel).toHaveBeenCalledTimes(1);
    expect(fetchChannel).toHaveBeenCalledWith(threadId);
    expect(result).toStrictEqual({});
  });
});
