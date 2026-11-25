import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import type { TelegramChatDetails, TelegramGetChat } from "./bot/types.js";
import { collectTelegramStatusIssues } from "./status-issues.js";
import {
  resolveTelegramAllowedReactions,
  resolveTelegramReactionVariant,
} from "./status-reaction-variants.js";

function collectIssues(overrides: Partial<ChannelAccountSnapshot>) {
  return collectTelegramStatusIssues([
    { accountId: "main", enabled: true, configured: true, ...overrides },
  ]);
}

describe("collectTelegramStatusIssues", () => {
  const runtime = (mode: string, lastError: string) => ({
    running: true,
    mode,
    connected: false,
    lastStartAt: Date.now() - 121_000,
    lastError,
  });
  it.each<[string, Partial<ChannelAccountSnapshot>, string, RegExp | RegExp[], string?]>([
    [
      "configuration risks",
      {
        allowUnmentionedGroups: true,
        audit: { hasWildcardUnmentionedGroups: true, unresolvedGroups: 2 },
      },
      "config",
      [/privacy mode/, /uses "\*"/, /unresolvedGroups=2/],
    ],
    [
      "unreachable",
      {
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
      },
      "runtime",
      /Group -100123 not reachable.*alerts.*channels\.telegram\.groups/,
    ],
    [
      "polling",
      runtime("polling", "network timeout"),
      "runtime",
      /has not completed a successful getUpdates call.*network timeout/,
      "channels status --probe",
    ],
    [
      "spool",
      runtime("polling", "Telegram isolated polling spool handler timed out"),
      "runtime",
      /spool backlog is stalled.*Telegram isolated polling spool handler timed out/,
    ],
    [
      "webhook",
      runtime("webhook", "fetch failed"),
      "runtime",
      /setWebhook has not completed.*fetch failed/,
      "webhook URL",
    ],
  ])("reports %s", (name, snapshot, kind, message, fix) => {
    const issues = collectIssues(snapshot);
    expect(issues).toEqual(
      (message instanceof RegExp ? [message] : message).map((pattern) =>
        expect.objectContaining({
          channel: "telegram",
          accountId: "main",
          kind,
          message: expect.stringMatching(pattern),
        }),
      ),
    );
    if (fix) {
      expect(issues[0]?.fix).toContain(fix);
    }
    if (name === "spool") {
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
        expect(issues).toMatchObject([{ channel: "telegram", accountId: "main", kind: "runtime" }]);
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
      reactions([
        emoji("👍"),
        custom("❤️"),
        { type: "emoji", emoji: "❤️" } as never,
        { type: "paid" },
      ]),
      [emoji("👍"), custom("❤️"), emoji("❤")],
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
        variantsByRequestedEmoji: new Map([["👨‍💻", ["👨‍💻", "⚡"]]]),
        allowedEmojiReactions: new Set(["🎉"]),
      }),
    ).toBeUndefined();
  });
});
