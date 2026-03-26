import type { APIMessage } from "discord-api-types/v10";
import { describe, expect, it } from "vitest";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import {
  collectMonitoredChannelIds,
  filterMissedMessages,
  resolveChannelRequireMention,
} from "./reconnect-catchup.js";

function createGuildEntries(
  overrides: Record<string, Partial<DiscordGuildEntryResolved>> = {},
): Record<string, DiscordGuildEntryResolved> {
  const base: Record<string, DiscordGuildEntryResolved> = {
    "guild-1": {
      channels: {
        "ch-1": { allow: true, requireMention: false },
        "ch-2": { allow: true, requireMention: true },
        "ch-3": { allow: false },
      },
      requireMention: false,
    } as DiscordGuildEntryResolved,
  };
  for (const [key, val] of Object.entries(overrides)) {
    base[key] = { ...base[key], ...val } as DiscordGuildEntryResolved;
  }
  return base;
}

function createAuthor(id: string): APIMessage["author"] {
  return {
    id,
    username: `user-${id}`,
    discriminator: "0",
    global_name: null,
    avatar: null,
  };
}

function createMessage(
  overrides: Omit<Partial<APIMessage>, "author"> & { id: string; author: { id: string } },
): APIMessage {
  return {
    channel_id: "ch-1",
    timestamp: new Date().toISOString(),
    content: "hello",
    mentions: [],
    ...overrides,
    author: createAuthor(overrides.author.id),
  } as unknown as APIMessage;
}

describe("collectMonitoredChannelIds", () => {
  it("returns empty for undefined guild entries", () => {
    expect(collectMonitoredChannelIds(undefined)).toEqual([]);
  });

  it("collects channels where allow is not false", () => {
    const entries = createGuildEntries();
    const ids = collectMonitoredChannelIds(entries);
    expect(ids).toContain("ch-1");
    expect(ids).toContain("ch-2");
    expect(ids).not.toContain("ch-3");
  });

  it("collects channels across multiple guilds", () => {
    const entries: Record<string, DiscordGuildEntryResolved> = {
      "guild-1": {
        channels: { "ch-a": { allow: true } },
      } as DiscordGuildEntryResolved,
      "guild-2": {
        channels: { "ch-b": { allow: true } },
      } as DiscordGuildEntryResolved,
    };
    const ids = collectMonitoredChannelIds(entries);
    expect(ids).toEqual(["ch-a", "ch-b"]);
  });

  it("skips guilds with no channels", () => {
    const entries: Record<string, DiscordGuildEntryResolved> = {
      "guild-1": {} as DiscordGuildEntryResolved,
    };
    expect(collectMonitoredChannelIds(entries)).toEqual([]);
  });
});

describe("resolveChannelRequireMention", () => {
  it("returns false for undefined guild entries", () => {
    expect(resolveChannelRequireMention("ch-1", undefined)).toBe(false);
  });

  it("returns channel-level requireMention when set", () => {
    const entries = createGuildEntries();
    expect(resolveChannelRequireMention("ch-2", entries)).toBe(true);
    expect(resolveChannelRequireMention("ch-1", entries)).toBe(false);
  });

  it("falls back to guild-level requireMention", () => {
    const entries: Record<string, DiscordGuildEntryResolved> = {
      "guild-1": {
        channels: { "ch-x": { allow: true } },
        requireMention: true,
      } as DiscordGuildEntryResolved,
    };
    expect(resolveChannelRequireMention("ch-x", entries)).toBe(true);
  });

  it("returns false for unknown channel", () => {
    const entries = createGuildEntries();
    expect(resolveChannelRequireMention("unknown", entries)).toBe(false);
  });
});

describe("filterMissedMessages", () => {
  const baseTime = Date.now() - 60_000;

  it("filters out bot's own messages", () => {
    const messages = [
      createMessage({
        id: "1",
        author: { id: "bot-123" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
      }),
      createMessage({
        id: "2",
        author: { id: "user-456" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
      }),
    ];
    const result = filterMissedMessages(messages, {
      botUserId: "bot-123",
      afterTimestamp: baseTime,
      requireMention: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("filters out messages before the gap", () => {
    const messages = [
      createMessage({
        id: "1",
        author: { id: "user-1" },
        timestamp: new Date(baseTime - 5_000).toISOString(),
      }),
      createMessage({
        id: "2",
        author: { id: "user-1" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
      }),
    ];
    const result = filterMissedMessages(messages, {
      afterTimestamp: baseTime,
      requireMention: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("filters by mention when requireMention is true", () => {
    const messages = [
      createMessage({
        id: "1",
        author: { id: "user-1" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
        mentions: [createAuthor("bot-123")] as APIMessage["mentions"],
      }),
      createMessage({
        id: "2",
        author: { id: "user-2" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
        mentions: [],
      }),
    ];
    const result = filterMissedMessages(messages, {
      botUserId: "bot-123",
      afterTimestamp: baseTime,
      requireMention: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("1");
  });

  it("passes all messages when requireMention is false", () => {
    const messages = [
      createMessage({
        id: "1",
        author: { id: "user-1" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
        mentions: [],
      }),
      createMessage({
        id: "2",
        author: { id: "user-2" },
        timestamp: new Date(baseTime + 30_000).toISOString(),
        mentions: [],
      }),
    ];
    const result = filterMissedMessages(messages, {
      afterTimestamp: baseTime,
      requireMention: false,
    });
    expect(result).toHaveLength(2);
  });

  it("returns empty for empty input", () => {
    const result = filterMissedMessages([], {
      afterTimestamp: baseTime,
      requireMention: false,
    });
    expect(result).toEqual([]);
  });
});
