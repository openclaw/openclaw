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

function createMentionContext(autoThread = true) {
  const guildInfo: DiscordGuildEntryResolved = {
    requireMention: true,
    channels: { general: { enabled: true, autoThread } },
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
    const { guildInfo, channelConfig } = createMentionContext(false);
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
    const cases = typedCases<
      [
        name: string,
        owner: string | undefined,
        autoOwned: boolean | undefined,
        requireMention: boolean | undefined,
        expected: boolean,
      ]
    >([
      ["bot-owned thread", "bot123", undefined, undefined, false],
      ["user-owned thread", "user456", undefined, undefined, true],
      ["unknown thread owner", undefined, undefined, undefined, true],
      ["precomputed ownership without metadata", undefined, true, undefined, false],
      ["precomputed exclusion overrides inferred ownership", "bot123", false, undefined, true],
      ["explicit mention requirement in bot threads", undefined, true, true, true],
      ["explicit bypass outside auto-threads", "bot123", false, false, false],
    ]);

    for (const [name, owner, autoOwned, requireMention, expected] of cases) {
      const { guildInfo, channelConfig } = createMentionContext();
      expect(
        resolveDiscordShouldRequireMention({
          isGuildMessage: true,
          isThread: true,
          botId: "bot123",
          threadOwnerId: owner,
          isAutoThreadOwnedByBot: autoOwned,
          channelConfig,
          guildInfo: { ...guildInfo, requireMentionInBotThreads: requireMention },
        }),
        name,
      ).toBe(expected);
    }
  });

  it("inherits parent channel mention rules for threads", () => {
    const guildInfo: DiscordGuildEntryResolved = {
      requireMention: true,
      channels: { "parent-1": { enabled: true, requireMention: false } },
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
    expect(channelConfig).toMatchObject({ matchSource: "parent", matchKey: "parent-1" });
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
