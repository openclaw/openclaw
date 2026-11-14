import { describe, expect, it } from "vitest";
import { markdownToSignalText, markdownToSignalTextChunks } from "./format.js";

describe("Signal formatting", () => {
  it("marks assistant-authored transcript role headers as monospace", () => {
    const result = markdownToSignalText("user[Thu 2026-07-02] question");

    expect(result.text).toBe("user[Thu 2026-07-02] question");
    expect(result.styles).toContainEqual({
      start: 0,
      length: "user[Thu 2026-07-02]".length,
      style: "MONOSPACE",
    });

    const spoilerResult = markdownToSignalText("||user[Thu 2026-07-02] hidden||");
    expect(spoilerResult.styles).toContainEqual({
      start: 0,
      length: "user[Thu 2026-07-02]".length,
      style: "MONOSPACE",
    });
  });

  it("does not duplicate URL for normalized equivalent labels", () => {
    const equivalentCases = [
      { input: "[selfh.st](http://selfh.st)", expected: "selfh.st" },
      { input: "[example.com](https://example.com)", expected: "example.com" },
      { input: "[www.example.com](https://example.com)", expected: "www.example.com" },
      { input: "[example.com](https://example.com/)", expected: "example.com" },
      { input: "[example.com](https://example.com///)", expected: "example.com" },
      { input: "[example.com](https://www.example.com)", expected: "example.com" },
      { input: "[EXAMPLE.COM](https://example.com)", expected: "EXAMPLE.COM" },
      { input: "[example.com/page](https://example.com/page)", expected: "example.com/page" },
      {
        input: "[HTTPS://EXAMPLE.COM/Report](https://example.com/Report)",
        expected: "HTTPS://EXAMPLE.COM/Report",
      },
      {
        input: "[WWW.EXAMPLE.COM/Report](https://example.com/Report)",
        expected: "WWW.EXAMPLE.COM/Report",
      },
      { input: "[USER@EXAMPLE.COM](mailto:user@example.com)", expected: "USER@EXAMPLE.COM" },
      {
        input: "[USER@EXAMPLE.COM?subject=HELLO](mailto:user@example.com?subject=hello)",
        expected: "USER@EXAMPLE.COM?subject=HELLO",
      },
    ] as const;

    for (const { input, expected } of equivalentCases) {
      const res = markdownToSignalText(input);
      expect(res.text).toBe(expected);
    }
  });

  it("marks a transcript-role header promoted to a chunk boundary", () => {
    const header = "user[2026-07-02]";
    const chunks = markdownToSignalTextChunks(`padding padding ${header} question`, 25);
    const roleChunk = chunks.find((chunk) => chunk.text.startsWith(header));

    expect(roleChunk).toBeDefined();
    expect(roleChunk?.styles).toContainEqual({
      start: 0,
      length: header.length,
      style: "MONOSPACE",
    });
    expect(chunks.every((chunk) => chunk.text.length <= 25)).toBe(true);
  });

  it("preserves case-distinct destinations and chunk-local UTF-16 styles", () => {
    const chunks = markdownToSignalTextChunks(
      "𐐀 [example.com/Report](https://example.com/report) **one**\n\n[example.com?id=AbC](https://example.com?id=abc) **two**",
      80,
    );
    const texts = [
      "𐐀 example.com/Report (https://example.com/report) one",
      "example.com?id=AbC (https://example.com?id=abc) two",
    ];
    expect(chunks).toEqual(
      texts.map((text) => ({
        text,
        styles: [{ start: text.length - 3, length: 3, style: "BOLD" }],
      })),
    );
  });

  it("prefixes every quoted line and keeps styles aligned", () => {
    const result = markdownToSignalText(
      "> > **one** [docs](https://example.com/a)\n> > two **three**\n>\n> back",
    );
    const text = "> > one docs (https://example.com/a)\n> > two three\n\n> back";

    expect(result).toEqual({
      text,
      styles: [
        { start: text.indexOf("one"), length: 3, style: "BOLD" },
        { start: text.indexOf("three"), length: 5, style: "BOLD" },
      ],
    });
  });

  it("prefixes quoted continuations in later chunks", () => {
    const chunks = markdownToSignalTextChunks(`> ${"word ".repeat(12)}`, 20);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.startsWith("> ") && chunk.text.length <= 20)).toBe(
      true,
    );
    expect(chunks.map((chunk) => chunk.text.slice(2)).join(" ")).toBe("word ".repeat(12).trim());
  });
});
