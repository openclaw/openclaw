// Discord plugin tests cover forum/media thread-name derivation.
import { describe, expect, it } from "vitest";
import { deriveForumThreadName } from "./send.outbound.js";

const DISCORD_THREAD_NAME_LIMIT = 100;

// Matches a high surrogate not followed by a low surrogate, or a low surrogate
// not preceded by a high one — i.e. a split surrogate pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("deriveForumThreadName", () => {
  it("uses the first non-empty line and caps it at the Discord limit", () => {
    const name = deriveForumThreadName(`\n  \n${"a".repeat(150)}`);
    expect(name).toBe("a".repeat(DISCORD_THREAD_NAME_LIMIT));
  });

  it("does not split a surrogate pair at the length boundary", () => {
    // 99 ASCII chars then an emoji whose surrogate pair straddles index 100.
    const text = `${"x".repeat(DISCORD_THREAD_NAME_LIMIT - 1)}😀 rest of the line`;
    const name = deriveForumThreadName(text);
    expect(name.length).toBeLessThanOrEqual(DISCORD_THREAD_NAME_LIMIT);
    expect(LONE_SURROGATE.test(name)).toBe(false);
    // The incomplete emoji is dropped rather than left as a dangling half.
    expect(name).toBe("x".repeat(DISCORD_THREAD_NAME_LIMIT - 1));
    // Guard: the previous raw slice produced a lone surrogate here.
    expect(LONE_SURROGATE.test(text.slice(0, DISCORD_THREAD_NAME_LIMIT))).toBe(true);
  });

  it("keeps a complete emoji that fits within the limit", () => {
    const name = deriveForumThreadName("hi 😀");
    expect(name).toBe("hi 😀");
    expect(LONE_SURROGATE.test(name)).toBe(false);
  });

  it("falls back to a timestamp when there is no usable line", () => {
    const name = deriveForumThreadName("\n   \n");
    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
