// Discord tests cover allow list plugin behavior.
import { typedCases } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  type DiscordGuildEntryResolved,
  normalizeDiscordDisplaySlug,
  normalizeDiscordSlug,
  resolveDiscordChannelConfig,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordShouldRequireMention,
} from "./allow-list.js";

describe("discord slug normalization", () => {
  it("keeps config slugs ASCII-only", () => {
    expect(normalizeDiscordSlug("\uC2E4\uD5D8")).toBe("");
    expect(normalizeDiscordSlug("baseline-\uAC80\uC99D")).toBe("baseline");
  });

  it("preserves Unicode in display slugs", () => {
    expect(normalizeDiscordDisplaySlug("\uC2E4\uD5D8")).toBe("\uC2E4\uD5D8");
    expect(normalizeDiscordDisplaySlug("baseline-\uAC80\uC99D")).toBe("baseline-\uAC80\uC99D");
  });
});

function createAutoThreadMentionContext() {
  const guildInfo: DiscordGuildEntryResolved = {
    requireMention: true,
    channels: {
      general: { enabled: true, autoThread: true },
    },
  };
  const channelConfig = resolveDiscordChannelConfig({
    guildInfo,
    channelId: "1",
    channelName: "General",
    channelSlug: "general",
  });
  return { guildInfo, channelConfig };
}

describe("discord mention gating", () => {
  it("requires mention by default", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        general: { enabled: true },
      },
    };
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: "1",
      channelName: "General",
      channelSlug: "general",
    });
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: false,
        channelConfig,
        guildInfo,
      }),
    ).toBe(true);
  });

  it("applies autoThread mention rules based on thread ownership", () => {
    const cases = typedCases<{
      name: string;
      threadOwnerId?: string;
      isAutoThreadOwnedByBot?: boolean;
      requireMentionInBotThreads?: boolean;
      expected: boolean;
    }>([
      { name: "bot-owned thread", threadOwnerId: "bot123", expected: false },
      { name: "user-owned thread", threadOwnerId: "user456", expected: true },
      { name: "unknown thread owner", threadOwnerId: undefined, expected: true },
      {
        name: "precomputed bot-owned auto-thread without owner metadata",
        isAutoThreadOwnedByBot: true,
        expected: false,
      },
      {
        name: "precomputed exclusion overrides inferred auto-thread ownership",
        threadOwnerId: "bot123",
        isAutoThreadOwnedByBot: false,
        expected: true,
      },
      {
        name: "explicit bot-thread policy requires mentions with precomputed ownership",
        isAutoThreadOwnedByBot: true,
        requireMentionInBotThreads: true,
        expected: true,
      },
      {
        name: "explicit bot-thread policy bypasses mentions outside auto-threads",
        threadOwnerId: "bot123",
        isAutoThreadOwnedByBot: false,
        requireMentionInBotThreads: false,
        expected: false,
      },
    ]);

    for (const testCase of cases) {
      const { guildInfo, channelConfig } = createAutoThreadMentionContext();
      expect(
        resolveDiscordShouldRequireMention({
          isGuildMessage: true,
          isThread: true,
          botId: "bot123",
          threadOwnerId: testCase.threadOwnerId,
          isAutoThreadOwnedByBot: testCase.isAutoThreadOwnedByBot,
          channelConfig,
          guildInfo: {
            ...guildInfo,
            requireMentionInBotThreads: testCase.requireMentionInBotThreads,
          },
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });

  it("inherits parent channel mention rules for threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: {
        "parent-1": { enabled: true, requireMention: false },
      },
    };
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: "thread-1",
      channelName: "topic",
      channelSlug: "topic",
      parentId: "parent-1",
      parentName: "Parent",
      parentSlug: "parent",
      scope: "thread",
    });
    expect(channelConfig?.matchSource).toBe("parent");
    expect(channelConfig?.matchKey).toBe("parent-1");
    expect(
      resolveDiscordShouldRequireMention({
        isGuildMessage: true,
        isThread: true,
        channelConfig,
        guildInfo,
      }),
    ).toBe(false);
  });
});
