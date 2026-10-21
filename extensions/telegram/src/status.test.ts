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

function collectIssues(overrides: Partial<ChannelAccountSnapshot>) {
  return collectTelegramStatusIssues([
    { accountId: "main", enabled: true, configured: true, ...overrides },
  ]);
}

function expectRuntimeIssue(issues: ReturnType<typeof collectIssues>) {
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ channel: "telegram", accountId: "main", kind: "runtime" });
}

describe("collectTelegramStatusIssues", () => {
  it("reports privacy-mode and wildcard unmentioned-group configuration risks", () => {
    const issues = collectIssues({
      allowUnmentionedGroups: true,
      audit: {
        hasWildcardUnmentionedGroups: true,
        unresolvedGroups: 2,
      },
    });

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
    const issues = collectIssues({
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
    });

    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain("Group -100123 not reachable");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("channels.telegram.groups");
  });

  it.each([
    [
      "polling",
      "network timeout",
      "has not completed a successful getUpdates call",
      "channels status --probe",
    ],
    [
      "polling",
      "Telegram isolated polling spool handler timed out",
      "spool backlog is stalled",
      undefined,
    ],
    ["webhook", "fetch failed", "setWebhook has not completed", "webhook URL"],
  ] as const)("reports disconnected %s runtime: %s", (mode, error, message, fix) => {
    const issues = collectIssues({
      running: true,
      mode,
      connected: false,
      lastStartAt: Date.now() - 121_000,
      lastError: error,
    });
    expectRuntimeIssue(issues);
    expect(issues[0]?.message).toContain(message);
    expect(issues[0]?.message).toContain(error);
    if (fix) {
      expect(issues[0]?.fix).toContain(fix);
    }
    if (error.includes("spool")) {
      expect(issues[0]?.message).not.toContain("has not completed a successful getUpdates call");
    }
  });

  it.each([
    ["polling", 3_600_000, 1_860_000, true],
    ["polling", 60_000, 7_200_000, false],
    ["webhook", 3_600_000, undefined, false],
  ] as const)(
    "checks connected %s lifecycle age %s / activity age %s",
    (mode, age, activityAge, stale) => {
      const now = Date.now();
      const issues = collectIssues({
        running: true,
        mode,
        connected: true,
        lastStartAt: now - age,
        ...(activityAge === undefined ? {} : { lastTransportActivityAt: now - activityAge }),
      });
      if (stale) {
        expectRuntimeIssue(issues);
        expect(issues[0]?.message).toContain("polling transport is stale");
      } else {
        expect(issues).toStrictEqual([]);
      }
    },
  );
});

describe("resolveTelegramAllowedReactions", () => {
  const allowed = (chat: TelegramChatDetails, getChat?: TelegramGetChat) =>
    resolveTelegramAllowedReactions({ chat, chatId: 1, getChat });
  it("assumes no restriction when chat does not include available_reactions", async () => {
    expect(await allowed({ id: 1 })).toBeNull();
  });

  it("preserves standard and custom reactions while omitting paid reactions", async () => {
    const result = await allowed({
      available_reactions: [
        { type: "emoji", emoji: "👍" },
        { type: "custom_emoji", custom_emoji_id: "abc" },
        { type: "emoji", emoji: "🔥" },
        { type: "paid" },
      ],
    });
    expect(result).toEqual([
      { type: "emoji", emoji: "👍" },
      { type: "custom_emoji", custom_emoji_id: "abc" },
      { type: "emoji", emoji: "🔥" },
    ]);
  });

  it("normalizes emoji presentation selectors while retaining custom reactions", async () => {
    const result = await allowed({
      available_reactions: [
        { type: "emoji", emoji: "❤️" },
        { type: "custom_emoji", custom_emoji_id: "❤️" },
      ],
    } as never);

    expect(result).toEqual([
      { type: "emoji", emoji: "❤" },
      { type: "custom_emoji", custom_emoji_id: "❤️" },
    ]);
  });

  it("treats malformed available_reactions payloads as an empty allowlist instead of throwing", async () => {
    await expect(
      allowed({ available_reactions: { type: "emoji", emoji: "👍" } } as never),
    ).resolves.toEqual([]);
  });

  it("uses getChat lookup when message chat does not include available_reactions", async () => {
    const getChat: TelegramGetChat = async () => ({
      available_reactions: [{ type: "emoji", emoji: "👍" }],
    });

    const result = await allowed({ id: 1 }, getChat);

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
