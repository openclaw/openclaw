import { describe, expect, it } from "vitest";
import type { GoogleChatAnnotation } from "./types.js";
import { isSenderAllowed, extractMentionInfo } from "./monitor.js";

describe("isSenderAllowed", () => {
  it("matches allowlist entries with raw email", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(true);
  });

  it("does not treat users/<email> entries as email allowlist (deprecated form)", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"])).toBe(
      false,
    );
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching raw email entries", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["other@example.com"])).toBe(false);
  });
});

describe("extractMentionInfo", () => {
  function mentionAnnotation(userName: string, userType?: string): GoogleChatAnnotation {
    return {
      type: "USER_MENTION",
      userMention: {
        user: { name: userName, type: userType },
      },
    };
  }

  it("detects mention via users/app alias", () => {
    const annotations = [mentionAnnotation("users/app")];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });

  it("detects mention via explicit botUser config", () => {
    const annotations = [mentionAnnotation("users/112986094383820258709")];
    const result = extractMentionInfo(annotations, "users/112986094383820258709");
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });

  it("detects mention via BOT user type when botUser is not configured", () => {
    // This is the core bug (#12323): Google Chat webhook sends numeric user IDs
    // like "users/112986094383820258709" instead of "users/app". Without botUser
    // configured, the only way to detect the bot mention is via user.type === "BOT".
    const annotations = [mentionAnnotation("users/112986094383820258709", "BOT")];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });

  it("skips BOT-type fallback when multiple BOT mentions exist (multi-bot safety)", () => {
    // In multi-bot Spaces, we can't distinguish which bot is ours without botUser config.
    // When multiple BOT-type mentions exist, require explicit botUser configuration.
    const annotations = [
      mentionAnnotation("users/112986094383820258709", "BOT"),
      mentionAnnotation("users/998877665544332211", "BOT"),
    ];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: false });
  });

  it("uses explicit botUser even when multiple BOT mentions exist", () => {
    const annotations = [
      mentionAnnotation("users/112986094383820258709", "BOT"),
      mentionAnnotation("users/998877665544332211", "BOT"),
    ];
    const result = extractMentionInfo(annotations, "users/112986094383820258709");
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });

  it("returns wasMentioned false for non-bot numeric user ID without config", () => {
    // Human mentions should not trigger the bot
    const annotations = [mentionAnnotation("users/112986094383820258709", "HUMAN")];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: false });
  });

  it("returns hasAnyMention false for empty annotations", () => {
    const result = extractMentionInfo([]);
    expect(result).toEqual({ hasAnyMention: false, wasMentioned: false });
  });

  it("ignores non-USER_MENTION annotations", () => {
    const annotations: GoogleChatAnnotation[] = [{ type: "SLASH_COMMAND" }, { type: "RICH_LINK" }];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: false, wasMentioned: false });
  });

  it("detects BOT-type mention alongside human mentions", () => {
    // One BOT mention + one human mention: BOT fallback should still work
    const annotations = [
      mentionAnnotation("users/112986094383820258709", "BOT"),
      mentionAnnotation("users/555666777888999", "HUMAN"),
    ];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });

  it("detects same bot mentioned twice (duplicate annotations, one distinct bot)", () => {
    // Same bot mentioned twice in one message — should still trigger since
    // there is only one distinct BOT user, not two different bots.
    const annotations = [
      mentionAnnotation("users/112986094383820258709", "BOT"),
      mentionAnnotation("users/112986094383820258709", "BOT"),
    ];
    const result = extractMentionInfo(annotations);
    expect(result).toEqual({ hasAnyMention: true, wasMentioned: true });
  });
});
