import { describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/reply-chunking", () => ({
  chunkMarkdownTextWithMode: (text: string) => [text],
}));

const { chunkDiscordText } = await import("./chunk.js");

describe("chunkDiscordText", () => {
  it("re-seeds blockquote context when splitting a long quoted line by chars", () => {
    const chunks = chunkDiscordText(`> ${"a".repeat(18)}`, {
      maxChars: 12,
      maxLines: 10,
    });

    expect(chunks).toEqual(["> aaaaaaaaa", "> aaaaaaaaa"]);
  });

  it("does not add an empty quoted line when splitting on line limits", () => {
    const chunks = chunkDiscordText(["> first", "> second", "> third"].join("\n"), {
      maxChars: 100,
      maxLines: 2,
    });

    expect(chunks).toEqual(["> first\n> second", "> third"]);
    expect(chunks[1]).not.toContain("> \n");
  });

  it("leaves non-blockquote content unchanged when chunking by lines", () => {
    const chunks = chunkDiscordText(["alpha", "beta", "gamma"].join("\n"), {
      maxChars: 100,
      maxLines: 2,
    });

    expect(chunks).toEqual(["alpha\nbeta", "gamma"]);
  });

  it("preserves nested blockquote prefixes across character splits", () => {
    const chunks = chunkDiscordText(`>> ${"b".repeat(20)}`, {
      maxChars: 12,
      maxLines: 10,
    });

    expect(chunks).toEqual([">> bbbbbbb", ">> bbbbbbbbbbbbb"]);
  });
});
