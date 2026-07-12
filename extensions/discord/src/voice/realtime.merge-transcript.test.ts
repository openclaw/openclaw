import { describe, expect, it } from "vitest";
import { mergeRealtimePartialTranscript } from "./realtime.js";

describe("mergeRealtimePartialTranscript", () => {
  it("returns previous transcript when the next chunk is blank", () => {
    expect(mergeRealtimePartialTranscript("hello", "   ")).toBe("hello");
  });

  it("replaces with the growing chunk when it extends the previous prefix", () => {
    expect(mergeRealtimePartialTranscript("hel", "hello world")).toBe("hello world");
  });

  it("appends when the next chunk is not a continuation of previous", () => {
    expect(mergeRealtimePartialTranscript("hello", " there")).toBe("hello there");
  });

  it("does not split a surrogate pair at the tail cap boundary", () => {
    // Grow the transcript past the 240-char cap with an emoji (🦞 = 2 UTF-16
    // code units) positioned so the tail cut lands on its low half. A raw
    // .slice(-cap) would return a leading lone surrogate (renders as �) and
    // corrupt the partial transcript fed back to the agent.
    const next = `${"y".repeat(50)}🦞${"x".repeat(239)}`;
    const merged = mergeRealtimePartialTranscript("", next);
    expect(merged).not.toContain("�");
    expect(merged).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(Buffer.from(merged, "utf8").toString("utf8")).toBe(merged);
    expect(merged.length).toBeLessThanOrEqual(240);
    expect(merged.endsWith("x".repeat(239))).toBe(true);
  });

  it("keeps an intact surrogate pair that sits just inside the cap", () => {
    // Emoji fully within the retained tail must survive unharmed.
    const next = `${"z".repeat(10)}🦞${"w".repeat(200)}`;
    const merged = mergeRealtimePartialTranscript("", next);
    expect(merged).toContain("🦞");
    expect(merged).not.toContain("�");
  });
});
