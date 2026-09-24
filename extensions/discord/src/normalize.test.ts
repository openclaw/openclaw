// Discord tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { looksLikeDiscordTargetId, normalizeDiscordMessagingTarget } from "./normalize.js";

describe("discord target normalization", () => {
  it("normalizes bare messaging target ids to channel targets", () => {
    expect(normalizeDiscordMessagingTarget("1234567890")).toBe("channel:1234567890");
  });

  it("detects Discord-style target identifiers", () => {
    expect(looksLikeDiscordTargetId("<@!123456>")).toBe(true);
    expect(looksLikeDiscordTargetId("user:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("discord:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("discord:user:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("discord:channel:123456")).toBe(true);
    expect(looksLikeDiscordTargetId("123456")).toBe(true);
    expect(looksLikeDiscordTargetId("channel:general")).toBe(false);
    expect(looksLikeDiscordTargetId("user:jane")).toBe(false);
    expect(looksLikeDiscordTargetId("discord:channel:general")).toBe(false);
    expect(looksLikeDiscordTargetId("hello world")).toBe(false);
  });
});
