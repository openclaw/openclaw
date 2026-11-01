import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";

type ChunkOptions = Parameters<typeof chunkDiscordTextWithMode>[1];
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

function split(text: string, options: ChunkOptions = {}, cap = options.maxChars ?? 2000) {
  const chunks = chunkDiscordTextWithMode(text, { chunkMode: "length", ...options });
  for (const value of chunks) {
    expect(value.length).toBeLessThanOrEqual(cap);
    expect(value).not.toMatch(loneSurrogate);
  }
  return chunks;
}

function inlineCodeSpans(markdown: string) {
  type Node = { type: string; value?: string; depth?: number; children?: Node[] };
  const values: Array<{ value: string; containers: string[] }> = [];
  const visit = (node: Node, containers: string[]) => {
    if (node.type === "inlineCode") {
      values.push({ value: (node.value ?? "").replace(/\r\n|[\r\n]/g, " "), containers });
    }
    const kind = node.type === "heading" ? `heading:${node.depth}` : node.type;
    const nested = ["blockquote", "list", "listItem", "heading", "paragraph"].includes(node.type)
      ? [...containers, kind]
      : containers;
    for (const child of node.children ?? []) {
      visit(child, nested);
    }
  };
  visit(fromMarkdown(markdown), []);
  return values;
}

describe("chunkDiscordText", () => {
  it.each([
    { chunkMode: "length" as const, maxLines: Number.POSITIVE_INFINITY },
    { chunkMode: "newline" as const, maxLines: 50 },
  ])("uses default chunk limits for non-finite options in $chunkMode mode", (options) => {
    const text = "x".repeat(2500);
    const chunks = split(text, { ...options, maxChars: Number.NaN }, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(text);
  });

  it("treats a CRLF line boundary like an LF boundary", () => {
    const lf = "hello world\n".repeat(500);
    const crlf = lf.replaceAll("\n", "\r\n");
    const lfChunks = split(lf);
    const crlfChunks = split(crlf);

    expect(crlfChunks.length).toBe(lfChunks.length);
    expect(crlfChunks.map((chunk) => chunk.replaceAll("\r\n", "\n"))).toEqual(lfChunks);
    expect(crlfChunks.every((chunk) => !chunk.endsWith("\r"))).toBe(true);
    expect(crlfChunks.every((chunk) => !/^[\r\n]/u.test(chunk))).toBe(true);
  });

  it("keeps closed fenced code blocks balanced across chunks", () => {
    const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
    const text = `Here is code:\n\n\`\`\`js\n${body}\n\`\`\`\n\nDone.`;

    const chunks = split(text, { maxChars: 2000, maxLines: 10 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      expect(hasBalancedFences(chunk)).toBe(true);
    }

    expect(chunks[0]).toContain("```js");
    expect(chunks.at(-1)).toContain("Done.");
  });

  it("keeps chunks within maxChars when a closing fence line carries trailing text", () => {
    // Reserve closing-fence space even when the closing line has a long tail.
    for (let pad = 1990; pad <= 2000; pad++) {
      const text = "hi\n```lang\n```" + "z".repeat(pad);
      split(text, { maxChars: 2000, maxLines: 100 });
    }
  });

  it("puts continued code on the line after a reopened fence", () => {
    const text = `\`\`\`ts\nconst value = '${"x".repeat(80)}';\n\`\`\``;
    const chunks = split(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const fencedBodyChunks = chunks.filter((chunk) => /^```(?:ts)?\n[^`]/.test(chunk));
    expect(fencedBodyChunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .filter((chunk) => chunk.startsWith("```"))
        .every((chunk) => /^```(?:ts)?(?:\n|$)/.test(chunk)),
    ).toBe(true);
  });

  it.each([
    ["```\nabcdefghij\n```", 8],
    ["~~~~~~~~\nabcdefghij\n~~~~~~~~", 18],
    [`Reasoning:\n_${"abcdef".repeat(8)}_`, 1],
  ] as const)("keeps the hard size limit for %j at %i chars", (text, maxChars) => {
    expect(split(text, { maxChars, maxLines: 50 }).length).toBeGreaterThan(1);
  });

  it("keeps a family emoji whole when the inline-code retry cut lands inside its ZWJ sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const cap = 2000;
    // Reopening backticks must step back over the whole cluster, not just a surrogate pair.
    const text = `\`${"a".repeat(cap - 12)}${family}${"Z".repeat(300)}\``;
    const chunks = split(text, { maxChars: cap, maxLines: 50 });

    expect(chunks).toEqual([`\`${"a".repeat(cap - 12)}\``, `\`${family}${"Z".repeat(300)}\``]);
    expect(chunks[0]).not.toContain("\u200D");
  });

  it.each([
    ["a tilde fence", ["~~~python", "print(1)", "~~~"], "~~~python\nprint(1)\n~~~"],
    ["a CRLF code fence", ["```ts\r", "body\r", "```\r", "more"], "```ts\r\nbody\r\n```\r\n_more_"],
    ["unmatched inline prose", ["`unclosed", "10. after"], "_`unclosed\n10. after_"],
  ] as const)("preserves %s at a reasoning chunk boundary", (_name, continuation, expected) => {
    const body = [
      ...Array.from({ length: 9 }, (_, index) => `${index + 1}. line`),
      ...continuation,
    ].join("\n");
    const chunks = split(`Reasoning:\n_${body}_`, {
      maxLines: 10,
      maxChars: 2000,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const second = expectDefined(chunks[1], "second Discord chunk");
    expect(second).toBe(expected);
    if (!expected.startsWith("_")) {
      expect(second.trimStart()).not.toMatch(/^_(```|~~~|`)/u);
    }
    for (const chunk of chunks) {
      expect((chunk.match(/_/g) || []).length % 2).toBe(0);
    }
  });
  function inlineCodeValue(text: string): string | undefined {
    const nodes = fromMarkdown(text).children;
    const paragraph = nodes[0];
    if (nodes.length !== 1 || paragraph?.type !== "paragraph" || paragraph.children.length !== 1) {
      return undefined;
    }
    const code = paragraph.children[0];
    return code?.type === "inlineCode" ? code.value : undefined;
  }

  it("preserves code content across newline mode", () => {
    const text = "`command " + "--argument=value ".repeat(160) + "`";
    const maxChars = 2000;
    const maxLines = 17;
    const expected = inlineCodeValue(text);
    const chunks = split(text, { maxChars, maxLines, chunkMode: "newline" });
    const values = chunks.map(inlineCodeValue);
    expect(chunks.length).toBeGreaterThan(1);
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.join("")).toBe(expected);
    expect(chunks.every((chunk) => countLines(chunk) <= maxLines)).toBe(true);
  });

  it.each([
    { text: "`aaaa``b`", maxChars: 6, maxLines: 17 },
    { text: "`\naaaa\r\nbbbb `", maxChars: 6, maxLines: 17 },
    { text: "```aa`\r\n``b```", maxChars: 9, maxLines: 2 },
  ])("preserves rendered inline content at $maxChars chars and $maxLines lines", (options) => {
    const chunks = split(options.text, options);
    const values = chunks.map(inlineCodeValue);
    const normalize = (value: string) => value.replace(/\r\n|[\r\n]/g, " ");
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.map((value) => normalize(value ?? "")).join("")).toBe(
      normalize(expectDefined(inlineCodeValue(options.text), "source inline code")),
    );
    expect(chunks.every((chunk) => countLines(chunk) <= options.maxLines)).toBe(true);
  });

  it("retains raw source when no inline backtick fragment fits the hard cap", () => {
    expect(split("`aaaa``b`", { maxChars: 5 })).toEqual(["`aaaa", "``b`"]);
  });

  it("sizes an oversized fence opener retained after inline code", () => {
    const source = "`a`\n```" + "x".repeat(1997) + "\ny\n```";
    const chunks = split(source);
    expect(chunks.join("")).toBe(source);
  });
  it("retains inline ownership after blockquote list prefixes", () => {
    const prefix = "> - item\n>\n>   ";
    for (const ending of ["\n", "\r\n"]) {
      const source =
        "Intro" + ending + prefix.replaceAll("\n", ending) + "`" + "a".repeat(2400) + "`";
      const expected = expectDefined(inlineCodeSpans(source)[0], "source container code");
      const chunks = split(source);
      const actual = chunks.flatMap(inlineCodeSpans);
      expect(actual.map(({ value }) => value).join("")).toBe(expected.value);
      for (const span of actual) {
        expect(span.containers).toEqual(expected.containers);
      }
    }
  });
});
