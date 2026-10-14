// Telegram tests cover status plugin behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_EMOJIS } from "openclaw/plugin-sdk/channel-feedback";
import { describe, expect, it } from "vitest";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import {
  buildTelegramStatusReactionVariants,
  resolveTelegramAllowedReactions,
  resolveTelegramReactionVariant,
} from "./status-reaction-variants.js";

function expectIssueMessageContains(
  issues: ReturnType<typeof collectTelegramStatusIssues>,
  text: string,
): void {
  expect(issues.map((issue) => issue.message).join("\n")).toContain(text);
}

describe("collectTelegramStatusIssues", () => {
  it("reports privacy-mode and wildcard unmentioned-group configuration risks", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        allowUnmentionedGroups: true,
        audit: {
          hasWildcardUnmentionedGroups: true,
          unresolvedGroups: 2,
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "telegram", accountId: "main", kind: "config" }),
      ]),
    );
    expectIssueMessageContains(issues, "privacy mode");
    expectIssueMessageContains(issues, 'uses "*"');
    expectIssueMessageContains(issues, "unresolvedGroups=2");
  });

  it("reports unreachable groups with match metadata", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        audit: {
          groups: [
            {
              chatId: "-100123",
              ok: false,
              status: "left",
              error: "403",
              matchKey: "alerts",
              matchSource: "channels.telegram.groups",
            },
          ],
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("Group -100123 not reachable");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("channels.telegram.groups");
  });

  it("reports polling runtime state that never completed getUpdates after startup grace", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "polling",
        connected: false,
        lastStartAt: Date.now() - 121_000,
        lastError: "network timeout",
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("has not completed a successful getUpdates call");
    expect(issues[0]?.message).toContain("network timeout");
    expect(issues[0]?.fix).toContain("channels status --probe");
  });

  it("reports isolated polling spool handler timeouts distinctly from startup failures", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "polling",
        connected: false,
        lastStartAt: Date.now() - 121_000,
        lastError:
          "Telegram isolated polling spool handler timed out behind update 42 on lane telegram:123 after 1500100ms; marking the update failed and restarting isolated ingress so later updates can drain.",
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("spool backlog is stalled");
    expect(issues[0]?.message).not.toContain("has not completed a successful getUpdates call");
  });

  it("reports stale polling transport activity after successful getUpdates stops refreshing", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "polling",
        connected: true,
        lastStartAt: Date.now() - 60 * 60_000,
        lastTransportActivityAt: Date.now() - 31 * 60_000,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("polling transport is stale");
  });

  it("does not report inherited stale transport activity during a fresh polling lifecycle", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "polling",
        connected: true,
        lastStartAt: Date.now() - 60_000,
        lastTransportActivityAt: Date.now() - 2 * 60 * 60_000,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toStrictEqual([]);
  });

  it("reports webhook runtime state that never completed setWebhook after startup grace", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "webhook",
        connected: false,
        lastStartAt: Date.now() - 10 * 60_000,
        lastError: "fetch failed",
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "telegram",
      accountId: "main",
      kind: "runtime",
    });
    expect(issues[0]?.message).toContain("setWebhook has not completed");
    expect(issues[0]?.message).toContain("fetch failed");
    expect(issues[0]?.fix).toContain("webhook URL");
  });

  it("does not report an advertised webhook just because no user updates arrived", () => {
    const issues = collectTelegramStatusIssues([
      {
        accountId: "main",
        enabled: true,
        configured: true,
        running: true,
        mode: "webhook",
        connected: true,
        lastStartAt: Date.now() - 60 * 60_000,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toStrictEqual([]);
  });
});

describe("resolveTelegramAllowedReactions", () => {
  it("assumes no restriction when chat does not include available_reactions", async () => {
    const result = await resolveTelegramAllowedReactions({
      chat: { id: 1 } satisfies TelegramChatDetails,
      chatId: 1,
    });
    expect(result).toBeNull();
  });

  it("preserves standard and custom reactions while omitting paid reactions", async () => {
    const result = await resolveTelegramAllowedReactions({
      chat: {
        available_reactions: [
          { type: "emoji", emoji: "👍" },
          { type: "custom_emoji", custom_emoji_id: "abc" },
          { type: "emoji", emoji: "🔥" },
          { type: "paid" },
        ],
      } satisfies TelegramChatDetails,
      chatId: 1,
    });
    expect(result).toEqual([
      { type: "emoji", emoji: "👍" },
      { type: "custom_emoji", custom_emoji_id: "abc" },
      { type: "emoji", emoji: "🔥" },
    ]);
  });

  it("normalizes emoji presentation selectors while retaining custom reactions", async () => {
    const result = await resolveTelegramAllowedReactions({
      chat: {
        available_reactions: [
          { type: "emoji", emoji: "❤️" },
          { type: "custom_emoji", custom_emoji_id: "❤️" },
        ],
      } as never,
      chatId: 1,
    });

    expect(result).toEqual([
      { type: "emoji", emoji: "❤" },
      { type: "custom_emoji", custom_emoji_id: "❤️" },
    ]);
  });

  it("treats malformed available_reactions payloads as an empty allowlist instead of throwing", async () => {
    await expect(
      resolveTelegramAllowedReactions({
        chat: { available_reactions: { type: "emoji", emoji: "👍" } } as never,
        chatId: 1,
      }),
    ).resolves.toEqual([]);
  });

  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat: TelegramGetChat = async () => ({
      available_reactions: [{ type: "emoji", emoji: "👍" }],
    });

    const result = await resolveTelegramAllowedReactions({
      chat: { id: 1 } satisfies TelegramChatDetails,
      chatId: 1,
      getChat,
    });

    expect(result).toEqual([{ type: "emoji", emoji: "👍" }]);
  });
});

describe("resolveTelegramReactionVariant", () => {
  it("returns undefined when no candidate is chat-allowed", () => {
    const variantsByEmoji = buildTelegramStatusReactionVariants({
      ...DEFAULT_EMOJIS,
      coding: "👨‍💻",
    });

    const result = resolveTelegramReactionVariant({
      requestedEmoji: "👨‍💻",
      variantsByRequestedEmoji: variantsByEmoji,
      allowedEmojiReactions: new Set(["🎉"]),
    });

    expect(result).toBeUndefined();
  });
});
