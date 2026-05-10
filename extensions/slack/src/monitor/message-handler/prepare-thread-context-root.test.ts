import { describe, expect, it } from "vitest";
import {
  applySlackThreadHistoryFilterPolicy,
  formatSlackBotStarterThreadLabel,
  isSlackThreadAuthorCurrentBot,
  resolveSlackThreadHistoryFilterPolicy,
  resolveSlackThreadIncludeRootMessage,
  shouldIncludeBotThreadStarterContext,
} from "./prepare-thread-context-root.js";

describe("isSlackThreadAuthorCurrentBot", () => {
  const identity = { botUserId: "U_BOT", botId: "B1" };

  it("matches the configured bot user id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { userId: "U_BOT" },
      }),
    ).toBe(true);
  });

  it("matches the configured bot id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { botId: "B1" },
      }),
    ).toBe(true);
  });

  it("does not match a different bot id", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { botId: "B2" },
      }),
    ).toBe(false);
  });

  it("does not match a regular user", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity,
        author: { userId: "U1" },
      }),
    ).toBe(false);
  });

  it("returns false when identity has no bot ids", () => {
    expect(
      isSlackThreadAuthorCurrentBot({
        identity: {},
        author: { userId: "U_BOT", botId: "B1" },
      }),
    ).toBe(false);
  });
});

describe("resolveSlackThreadIncludeRootMessage", () => {
  it("defaults to true when not specified", () => {
    expect(resolveSlackThreadIncludeRootMessage({})).toBe(true);
  });

  it("defaults to true when thread config is empty", () => {
    expect(resolveSlackThreadIncludeRootMessage({ thread: {} })).toBe(true);
  });

  it("respects an explicit false", () => {
    expect(resolveSlackThreadIncludeRootMessage({ thread: { includeRootMessage: false } })).toBe(
      false,
    );
  });

  it("respects an explicit true", () => {
    expect(resolveSlackThreadIncludeRootMessage({ thread: { includeRootMessage: true } })).toBe(
      true,
    );
  });
});

describe("resolveSlackThreadHistoryFilterPolicy", () => {
  it("retains current-bot messages when starting a new session and root inclusion is on", () => {
    expect(
      resolveSlackThreadHistoryFilterPolicy({
        isNewThreadSession: true,
        includeRootMessage: true,
      }),
    ).toEqual({ retainCurrentBotMessages: true });
  });

  it("filters current-bot messages when root inclusion is off", () => {
    expect(
      resolveSlackThreadHistoryFilterPolicy({
        isNewThreadSession: true,
        includeRootMessage: false,
      }),
    ).toEqual({ retainCurrentBotMessages: false });
  });

  it("filters current-bot messages on existing sessions", () => {
    expect(
      resolveSlackThreadHistoryFilterPolicy({
        isNewThreadSession: false,
        includeRootMessage: true,
      }),
    ).toEqual({ retainCurrentBotMessages: false });
  });
});

describe("applySlackThreadHistoryFilterPolicy", () => {
  const identity = { botUserId: "U_BOT", botId: "B1" };

  it("keeps every message when policy retains current-bot entries", () => {
    const history = [
      { ts: "1", botId: "B1", text: "bot root" },
      { ts: "2", userId: "U1", text: "user reply" },
    ];
    const result = applySlackThreadHistoryFilterPolicy({
      history,
      policy: { retainCurrentBotMessages: true },
      identity,
    });
    expect(result.kept).toEqual(history);
    expect(result.omittedCurrentBot).toBe(0);
  });

  it("filters current-bot messages and reports counts when policy excludes them", () => {
    const history = [
      { ts: "1", botId: "B1", text: "bot root" },
      { ts: "2", userId: "U_BOT", text: "bot via user id" },
      { ts: "3", userId: "U1", text: "user reply" },
      { ts: "4", botId: "B2", text: "third-party bot" },
    ];
    const result = applySlackThreadHistoryFilterPolicy({
      history,
      policy: { retainCurrentBotMessages: false },
      identity,
    });
    expect(result.kept.map((entry) => entry.ts)).toEqual(["3", "4"]);
    expect(result.omittedCurrentBot).toBe(2);
  });

  it("returns an empty result for empty history", () => {
    const result = applySlackThreadHistoryFilterPolicy({
      history: [] as Array<{ ts: string; userId?: string; botId?: string }>,
      policy: { retainCurrentBotMessages: false },
      identity,
    });
    expect(result.kept).toEqual([]);
    expect(result.omittedCurrentBot).toBe(0);
  });
});

describe("shouldIncludeBotThreadStarterContext", () => {
  it("includes when starter is bot, session is new, root inclusion is on, and starter has text", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: true,
        includeRootMessage: true,
        hasStarterText: true,
      }),
    ).toBe(true);
  });

  it("does not include when starter is not the current bot", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: false,
        isNewThreadSession: true,
        includeRootMessage: true,
        hasStarterText: true,
      }),
    ).toBe(false);
  });

  it("does not include when session is not new", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: false,
        includeRootMessage: true,
        hasStarterText: true,
      }),
    ).toBe(false);
  });

  it("does not include when root inclusion is off", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: true,
        includeRootMessage: false,
        hasStarterText: true,
      }),
    ).toBe(false);
  });

  it("does not include when starter has no text", () => {
    expect(
      shouldIncludeBotThreadStarterContext({
        starterIsCurrentBot: true,
        isNewThreadSession: true,
        includeRootMessage: true,
        hasStarterText: false,
      }),
    ).toBe(false);
  });
});

describe("formatSlackBotStarterThreadLabel", () => {
  it("returns base label when starter text is missing", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM" })).toBe("Slack thread DM");
  });

  it("returns base label when starter text is empty", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: "" })).toBe(
      "Slack thread DM",
    );
  });

  it("returns base label when starter text collapses to whitespace snippet", () => {
    expect(formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: "   " })).toBe(
      "Slack thread DM",
    );
  });

  it("appends an assistant root snippet to the room label", () => {
    expect(
      formatSlackBotStarterThreadLabel({
        roomLabel: "#general",
        starterText: "Confirmed meeting at noon",
      }),
    ).toBe("Slack thread #general (assistant root): Confirmed meeting at noon");
  });

  it("truncates long starter text to 80 characters", () => {
    const longText = "x".repeat(120);
    const label = formatSlackBotStarterThreadLabel({ roomLabel: "DM", starterText: longText });
    expect(label.endsWith("x".repeat(80))).toBe(true);
  });

  it("collapses internal whitespace", () => {
    expect(
      formatSlackBotStarterThreadLabel({
        roomLabel: "DM",
        starterText: "Line one\n\nLine two",
      }),
    ).toBe("Slack thread DM (assistant root): Line one Line two");
  });
});
