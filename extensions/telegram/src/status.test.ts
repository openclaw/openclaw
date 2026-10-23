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

function expectMessage(message: string | undefined, ...texts: string[]) {
  for (const text of texts) {
    expect(message).toContain(text);
  }
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
    expectMessage(
      issues.map((issue) => issue.message).join("\n"),
      "privacy mode",
      'uses "*"',
      "unresolvedGroups=2",
    );
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
    expectMessage(
      issues[0]?.message,
      "Group -100123 not reachable",
      "alerts",
      "channels.telegram.groups",
    );
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
    expectMessage(issues[0]?.message, message, error);
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
  const emoji = (value: "👍" | "🔥" | "❤") => ({ type: "emoji" as const, emoji: value });
  const custom = (value: string) => ({ type: "custom_emoji" as const, custom_emoji_id: value });
  const reactions = (available_reactions: TelegramChatDetails["available_reactions"]) => ({
    available_reactions,
  });
  it.each<[string, TelegramChatDetails, unknown, TelegramGetChat?]>([
    ["missing metadata", { id: 1 }, null],
    [
      "standard/custom but not paid",
      reactions([emoji("👍"), custom("abc"), emoji("🔥"), { type: "paid" }]),
      [emoji("👍"), custom("abc"), emoji("🔥")],
    ],
    [
      "presentation selectors",
      reactions([{ type: "emoji", emoji: "❤️" } as never, custom("❤️")]),
      [emoji("❤"), custom("❤️")],
    ],
    ["malformed payload", { available_reactions: emoji("👍") } as never, []],
    ["getChat fallback", { id: 1 }, [emoji("👍")], async () => reactions([emoji("👍")])],
  ])("resolves allowed reactions from %s", async (_name, chat, expected, getChat) => {
    await expect(allowed(chat, getChat)).resolves.toEqual(expected);
  });
});

describe("resolveTelegramReactionVariant", () => {
  it("returns undefined when no candidate is chat-allowed", () => {
    expect(
      resolveTelegramReactionVariant({
        requestedEmoji: "👨‍💻",
        variantsByRequestedEmoji: buildTelegramStatusReactionVariants({
          ...DEFAULT_EMOJIS,
          coding: "👨‍💻",
        }),
        allowedEmojiReactions: new Set(["🎉"]),
      }),
    ).toBeUndefined();
  });
});
