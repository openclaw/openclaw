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

  it.each([
    ["[selfh.st](http://selfh.st)", "selfh.st"],
    ["[example.com](https://example.com)", "example.com"],
    ["[www.example.com](https://example.com)", "www.example.com"],
    ["[example.com](https://example.com/)", "example.com"],
    ["[example.com](https://example.com///)", "example.com"],
    ["[example.com](https://www.example.com)", "example.com"],
    ["[EXAMPLE.COM](https://example.com)", "EXAMPLE.COM"],
    ["[example.com/page](https://example.com/page)", "example.com/page"],
    ["[HTTPS://EXAMPLE.COM/Report](https://example.com/Report)", "HTTPS://EXAMPLE.COM/Report"],
    ["[WWW.EXAMPLE.COM/Report](https://example.com/Report)", "WWW.EXAMPLE.COM/Report"],
    ["[USER@EXAMPLE.COM](mailto:user@example.com)", "USER@EXAMPLE.COM"],
    [
      "[USER@EXAMPLE.COM?subject=HELLO](mailto:user@example.com?subject=hello)",
      "USER@EXAMPLE.COM?subject=HELLO",
    ],
    ["See https://ja.wikipedia.org/wiki/東京", "See https://ja.wikipedia.org/wiki/東京"],
    [
      "[https://ja.wikipedia.org/wiki/東京](https://ja.wikipedia.org/wiki/東京)",
      "https://ja.wikipedia.org/wiki/東京",
    ],
    ["https://example.com/?q=a|b", "https://example.com/?q=a|b"],
    ["https://example.com/a%20b", "https://example.com/a b (https://example.com/a%20b)"],
    [
      "[https://example.com/%41](https://example.com/%2541)",
      "https://example.com/%41 (https://example.com/%2541)",
    ],
  ] as const)("renders URL labels without losing distinct destinations: %s", (input, expected) => {
    expect(markdownToSignalText(input).text).toBe(expected);
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

  it.each([
    ["`  go  `", " go "],
    ["`   `", "   "],
  ])("keeps the entire terminal inline-code cell %s after an expanded link", (cell, code) => {
    const table = `| ID | Value |\n| --- | --- |\n| [manual](https://example.org) | ${cell} |`;
    const prefix = "manual (https://example.org)\n• Value: ";
    const formatted = markdownToSignalText(table, { tableMode: "bullets" });
    expect(formatted.text).toBe(prefix + code);
    expect(formatted.styles).toContainEqual({
      start: prefix.length,
      length: code.length,
      style: "MONOSPACE",
    });
  });

  it("preserves inline-code spaces at an internal packet boundary", () => {
    const label = "👋 " + "label ".repeat(7);
    const table = `| ID | Value |\n| --- | --- |\n| ${label} | \`  go  \` |\n| after | Done |`;
    const chunks = markdownToSignalTextChunks(table, 20, { tableMode: "bullets" });
    const code = chunks.flatMap(({ text, styles }) =>
      styles
        .filter((range) => range.style === "MONOSPACE")
        .map(({ start, length }) => text.slice(start, start + length)),
    );
    expect(code).toEqual([" go "]);
    expect(chunks.every(({ text }) => text.length <= 20)).toBe(true);
    expect(chunks.at(-1)?.text).toContain("Done");
  });

  it("trims ordinary trailing whitespace and fenced-code framing", () => {
    expect(markdownToSignalText("ordinary   ").text).toBe("ordinary");
    expect(markdownToSignalText("```\nhello\n```").text).toBe("hello");
  });

  it("prefixes every quoted line and chunk while styles keep their words", () => {
    expect(
      markdownToSignalText(
        "> line one\n> **line two**\n>\n> second para\n> > nested one\n> > nested two",
      ),
    ).toEqual({
      text: "> line one\n> line two\n\n> second para\n\n> > nested one\n> > nested two",
      styles: [{ start: 13, length: 8, style: "BOLD" }],
    });
    expect(
      markdownToSignalTextChunks(`> ${"word ".repeat(18)}`, 40).map((chunk) => chunk.text),
    ).toEqual([
      "> word word word word word word word",
      "> word word word word word word word",
      "> word word word word",
    ]);
  });

  it("keeps the quote prefix when a transcript-role header starts a chunk", () => {
    const header = "user[2026-07-02]";
    const chunks = markdownToSignalTextChunks(`> > padding padding ${header} question`, 25);
    const roleChunk = chunks.find((chunk) => chunk.text.includes(header));

    expect(roleChunk?.text).toBe(`> > ${header}`);
    expect(roleChunk?.styles).toContainEqual({
      start: "> > ".length,
      length: header.length,
      style: "MONOSPACE",
    });
  });
});
