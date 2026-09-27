// Mattermost test support covers monitor helpers plugin behavior.
import { describe, expect, it } from "vitest";
import {
  matchesMattermostBotMention,
  normalizeMention,
  shouldDropEmptyMattermostBody,
} from "./monitor-helpers.js";

describe("matchesMattermostBotMention", () => {
  it.each(["hey @echobot check this", "(@echobot)", "@echobot...", "@EchoBot hello"])(
    "matches a real bot mention: %j",
    (text) => {
      expect(matchesMattermostBotMention(text, "echobot")).toBe(true);
    },
  );

  // Mattermost usernames allow [a-z0-9._-]; these are mentions of other users.
  it.each([
    "@echobot.dia hello",
    "@echobot-ops please review",
    "@echobot_2 ping",
    "@echobot::remote hello",
    "mail me at bob@echobot later",
  ])("does not match a longer username or embedded handle: %j", (text) => {
    expect(matchesMattermostBotMention(text, "echobot")).toBe(false);
  });

  it("returns false without a bot username", () => {
    expect(matchesMattermostBotMention("@echobot hello", undefined)).toBe(false);
  });
});

describe("normalizeMention", () => {
  it("returns trimmed text when no mention provided", () => {
    expect(normalizeMention("  hello world  ", undefined)).toBe("hello world");
  });

  it("strips mention case-insensitively", () => {
    expect(normalizeMention("@EchoBot hello", "echobot")).toBe("hello");
  });

  it("handles mention in middle of text", () => {
    const input = "hey @echobot check this\nout";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("hey check this\nout");
  });

  it("preserves first-line indentation for nested list items", () => {
    const input = "@echobot\n  - nested\n    - deep";
    const result = normalizeMention(input, "echobot");
    expect(result).toBe("  - nested\n    - deep");
  });

  it.each([
    "@echobot.dia hello",
    "@echobot-ops please review",
    "@echobot:remote hello",
    "mail me at bob@echobot later",
  ])("leaves other users' handles intact: %j", (input) => {
    expect(normalizeMention(input, "echobot")).toBe(input);
  });

  it("preserves table padding on lines without the mention", () => {
    const input = "@echobot see table\n| a | b |\n| aaa    | bbb |";
    expect(normalizeMention(input, "echobot")).toBe("see table\n| a | b |\n| aaa    | bbb |");
  });

  it("still collapses doubled spaces on the line the mention was removed from", () => {
    expect(normalizeMention("hey  @echobot  check", "echobot")).toBe("hey check");
  });
});

describe("shouldDropEmptyMattermostBody", () => {
  it("drops a non-mention message that normalizes to an empty body", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "   ",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("keeps a bare mention in a direct message", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "@OpenClaw",
        botUsername: "openclaw",
      }),
    ).toBe(false);
  });

  it("drops an empty body when the bot username is unknown", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText: "@someoneelse",
        botUsername: undefined,
      }),
    ).toBe(true);
  });

  it("drops a bot mention with only a Unicode control residual", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "\u0085",
        rawText: "@openclaw\u0085",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it("drops a bot mention with only a combining-mark residual", () => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "\ufe0f",
        rawText: "@openclaw\ufe0f",
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });

  it.each([
    "@openclaw @openclaw",
    "@openclaw\n@openclaw",
    "@openclaw\n",
    "\n@openclaw",
    "@openclaw\r\n",
    "@openclaw\u2028",
    "@openclaw\u2029",
    "\v@openclaw\f",
    "@openclaw\u00a0",
    "\u2003@openclaw",
  ])("drops an invalid empty-body candidate: %j", (rawText) => {
    expect(
      shouldDropEmptyMattermostBody({
        bodyText: "",
        rawText,
        botUsername: "openclaw",
      }),
    ).toBe(true);
  });
});
