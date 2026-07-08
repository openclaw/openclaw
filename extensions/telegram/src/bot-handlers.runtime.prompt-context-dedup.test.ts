import { describe, expect, it } from "vitest";
import { resolvePromptContextTextDedupeKey } from "./bot-handlers.runtime.js";

describe("resolvePromptContextTextDedupeKey", () => {
  it("returns undefined for non-string body", () => {
    expect(resolvePromptContextTextDedupeKey({ body: undefined })).toBeUndefined();
    expect(resolvePromptContextTextDedupeKey({ body: 42 })).toBeUndefined();
    expect(resolvePromptContextTextDedupeKey({})).toBeUndefined();
  });

  it("returns undefined for empty body after trimming", () => {
    expect(resolvePromptContextTextDedupeKey({ body: "   ", timestamp_ms: 1000 })).toBeUndefined();
  });

  it("returns undefined when timestamp_ms is missing or invalid", () => {
    expect(
      resolvePromptContextTextDedupeKey({ body: "hello world this is long enough" }),
    ).toBeUndefined();
    expect(
      resolvePromptContextTextDedupeKey({
        body: "hello world this is long enough",
        timestamp_ms: Number.NaN,
      }),
    ).toBeUndefined();
    expect(
      resolvePromptContextTextDedupeKey({
        body: "hello world this is long enough",
        timestamp_ms: Infinity,
      }),
    ).toBeUndefined();
  });

  it("produces matching keys for the same text with different Markdown formatting", () => {
    const plain = "The quick brown fox jumps over the lazy dog";
    const bold = "**The quick brown fox jumps over the lazy dog**";
    const italic = "_The quick brown fox jumps over the lazy dog_";
    const code = "`The quick brown fox jumps over the lazy dog`";

    const keyPlain = resolvePromptContextTextDedupeKey({ body: plain, timestamp_ms: 1000 });
    const keyBold = resolvePromptContextTextDedupeKey({ body: bold, timestamp_ms: 1000 });
    const keyItalic = resolvePromptContextTextDedupeKey({ body: italic, timestamp_ms: 1000 });
    const keyCode = resolvePromptContextTextDedupeKey({ body: code, timestamp_ms: 1000 });

    expect(keyPlain).toBe(keyBold);
    expect(keyPlain).toBe(keyItalic);
    expect(keyPlain).toBe(keyCode);
    expect(keyPlain).toBe("1000:The quick brown fox jumps over the lazy dog");
  });

  it("produces different keys for different timestamps", () => {
    const key1 = resolvePromptContextTextDedupeKey({
      body: "hello world",
      timestamp_ms: 1000,
    });
    const key2 = resolvePromptContextTextDedupeKey({
      body: "hello world",
      timestamp_ms: 2000,
    });

    expect(key1).toBe("1000:hello world");
    expect(key2).toBe("2000:hello world");
    expect(key1).not.toBe(key2);
  });

  it("strips Markdown formatting from short bodies too", () => {
    const key = resolvePromptContextTextDedupeKey({
      body: "**ok**",
      timestamp_ms: 1000,
    });

    expect(key).toBe("1000:ok");
  });

  it("preserves literal underscores inside words (regression)", () => {
    const key = resolvePromptContextTextDedupeKey({
      body: "check this_here_value now",
      timestamp_ms: 1000,
    });

    expect(key).toBe("1000:check this_here_value now");
  });
});
