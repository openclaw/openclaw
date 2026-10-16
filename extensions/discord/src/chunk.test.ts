import { expectDefined } from "@openclaw/normalization-core";
import { fromMarkdown } from "mdast-util-from-markdown";
import { countLines, hasBalancedFences } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { chunkDiscordTextWithMode } from "./chunk.js";

type ChunkOptions = Omit<Parameters<typeof chunkDiscordTextWithMode>[1], "chunkMode">;

function chunkDiscordText(text: string, options: ChunkOptions = {}) {
  return chunkDiscordTextWithMode(text, { ...options, chunkMode: "length" });
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
  it("uses default chunk limits for non-finite options", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordText(text, {
      maxChars: Number.NaN,
      maxLines: Number.POSITIVE_INFINITY,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it.each([{ ending: "closed", suffix: "\n```\n\nDone." }])(
    "keeps $ending fenced code blocks balanced across chunks",
    ({ suffix }) => {
      const body = Array.from({ length: 30 }, (_, i) => `console.log(${i});`).join("\n");
      const text = `Here is code:\n\n\`\`\`js\n${body}${suffix}`;

      const chunks = chunkDiscordText(text, { maxChars: 2000, maxLines: 10 });
      expect(chunks.length).toBeGreaterThan(1);

      for (const chunk of chunks) {
        expect(hasBalancedFences(chunk)).toBe(true);
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }

      expect(chunks[0]).toContain("```js");
      expect(chunks.at(-1)).toContain(suffix ? "Done." : "console.log(29);");
    },
  );

  it("uses default newline chunk limits for non-finite max chars", () => {
    const text = "x".repeat(2500);
    const chunks = chunkDiscordTextWithMode(text, {
      maxChars: Number.NaN,
      maxLines: 50,
      chunkMode: "newline",
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(text);
  });

  it("keeps chunks within maxChars when a closing fence line carries trailing text", () => {
    // A line that both closes the fence and carries a long tail must still reserve closing-fence
    // space; otherwise a mid-line flush appended "```" and overflowed maxChars (e.g. 2004 > 2000).
    for (let pad = 1990; pad <= 2000; pad++) {
      const text = "hi\n```lang\n```" + "z".repeat(pad);
      for (const chunk of chunkDiscordText(text, { maxChars: 2000, maxLines: 100 })) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
    }
  });

  it("puts continued code on the line after a reopened fence", () => {
    const text = `\`\`\`ts\nconst value = '${"x".repeat(80)}';\n\`\`\``;
    const chunks = chunkDiscordText(text, { maxChars: 30, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    const fencedBodyChunks = chunks.filter((chunk) => /^```(?:ts)?\n[^`]/.test(chunk));
    expect(fencedBodyChunks.length).toBeGreaterThan(1);
    expect(
      chunks
        .filter((chunk) => chunk.startsWith("```"))
        .every((chunk) => /^```(?:ts)?(?:\n|$)/.test(chunk)),
    ).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 30)).toBe(true);
  });

  it("keeps the hard size limit when synthetic fence balancing cannot fit", () => {
    const cases = [
      { text: "```\nabcdefghij\n```", maxChars: 8 },
      { text: "~~~~~~~~\nabcdefghij\n~~~~~~~~", maxChars: 18 },
    ];

    for (const { text, maxChars } of cases) {
      const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });
      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
    }
  });

  it("keeps a family emoji whole when the inline-code retry cut lands inside its ZWJ sequence", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
    const cap = 2000;
    // The shared cutter keeps the family whole at exactly the cap; Discord's render then
    // appends the re-opened backtick and its local retry loop must step back over the
    // whole cluster, not just a surrogate pair.
    const text = `\`${"a".repeat(cap - 12)}${family}${"Z".repeat(300)}\``;
    const chunks = chunkDiscordText(text, { maxChars: cap, maxLines: 50 });

    expect(chunks).toEqual([`\`${"a".repeat(cap - 12)}\``, `\`${family}${"Z".repeat(300)}\``]);
    expect(chunks.every((chunk) => chunk.length <= cap)).toBe(true);
    expect(chunks[0]).not.toContain("\u200D");
  });

  it.each([1])("never exceeds a %i-character reasoning chunk limit", (maxChars) => {
    const text = `Reasoning:\n_${"abcdef".repeat(8)}_`;

    const chunks = chunkDiscordText(text, { maxChars, maxLines: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= maxChars)).toBe(true);
  });

  it.each([
    ["a tilde fence", ["~~~python", "print(1)", "~~~"], "~~~python\nprint(1)\n~~~"],
    ["a CRLF code fence", ["```ts\r", "body\r", "```\r", "more"], "```ts\r\nbody\r\n```\r\n_more_"],
  ] as const)("preserves %s at a reasoning chunk boundary", (_name, continuation, expected) => {
    const body = [
      ...Array.from({ length: 9 }, (_, index) => `${index + 1}. line`),
      ...continuation,
    ].join("\n");
    const chunks = chunkDiscordText(`Reasoning:\n_${body}_`, {
      maxLines: 10,
      maxChars: 2000,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const second = expectDefined(chunks[1], "second Discord chunk");
    expect(second).toBe(expected);
    expect(second.trimStart()).not.toMatch(/^_(```|~~~|`)/u);
    for (const chunk of chunks) {
      expect((chunk.match(/_/g) || []).length % 2).toBe(0);
    }
  });

  it("treats an unmatched inline delimiter as reasoning prose", () => {
    const body = [
      ...Array.from({ length: 9 }, (_, index) => `${index + 1}. line`),
      "`unclosed",
      "10. after",
    ].join("\n");
    const chunks = chunkDiscordText(`Reasoning:\n_${body}_`, {
      maxLines: 10,
      maxChars: 2000,
    });

    expect(expectDefined(chunks[1], "second Discord chunk")).toBe("_`unclosed\n10. after_");
    expect(chunks.every((chunk) => (chunk.match(/_/g) || []).length % 2 === 0)).toBe(true);
  });
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

describe("Discord inline-code chunk boundaries", () => {
  it.each([
    {
      name: "newline mode",
      text: "`command " + "--argument=value ".repeat(160) + "`",
      maxChars: 2000,
      maxLines: 17,
      chunkMode: "newline" as const,
    },
  ])("preserves code content across $name", ({ text, maxChars, maxLines, chunkMode }) => {
    const expected = inlineCodeValue(text);
    const chunks = chunkDiscordTextWithMode(text, { maxChars, maxLines, chunkMode });
    const values = chunks.map(inlineCodeValue);
    expect(expected).toBeDefined();
    expect(chunks.length).toBeGreaterThan(1);
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.join("")).toBe(expected);
    expect(chunks.every((chunk) => chunk.length <= maxChars && countLines(chunk) <= maxLines)).toBe(
      true,
    );
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
      );
    }
  });

  it.each([
    { text: "`aaaa``b`", maxChars: 6, maxLines: 17 },
    { text: "`\naaaa\r\nbbbb `", maxChars: 6, maxLines: 17 },
    { text: "```aa`\r\n``b```", maxChars: 9, maxLines: 2 },
  ])("preserves rendered inline content at $maxChars chars and $maxLines lines", (options) => {
    const chunks = chunkDiscordTextWithMode(options.text, options);
    const values = chunks.map(inlineCodeValue);
    const normalize = (value: string) => value.replace(/\r\n|[\r\n]/g, " ");
    expect(values.every((value) => value !== undefined)).toBe(true);
    expect(values.map((value) => normalize(value ?? "")).join("")).toBe(
      normalize(expectDefined(inlineCodeValue(options.text), "source inline code")),
    );
    expect(
      chunks.every(
        (chunk) => chunk.length <= options.maxChars && countLines(chunk) <= options.maxLines,
      ),
    ).toBe(true);
  });

  it("retains raw source when no inline backtick fragment fits the hard cap", () => {
    expect(chunkDiscordText("`aaaa``b`", { maxChars: 5 })).toEqual(["`aaaa", "``b`"]);
  });

  it("sizes an oversized fence opener retained after inline code", () => {
    const source = "`a`\n```" + "x".repeat(1997) + "\ny\n```";
    const chunks = chunkDiscordText(source);
    expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    expect(chunks.join("")).toBe(source);
  });
  it.each(["> - item\n>\n>   "])("retains inline ownership after container prefix %j", (prefix) => {
    for (const ending of ["\n", "\r\n"]) {
      const source =
        "Intro" + ending + prefix.replaceAll("\n", ending) + "`" + "a".repeat(2400) + "`";
      const expected = expectDefined(inlineCodeSpans(source)[0], "source container code");
      const chunks = chunkDiscordText(source);
      const actual = chunks.flatMap(inlineCodeSpans);
      expect(actual.map(({ value }) => value).join("")).toBe(expected.value);
      for (const span of actual) {
        expect(span.containers).toEqual(expected.containers);
      }
      expect(chunks.every((chunk) => chunk.length <= 2000)).toBe(true);
    }
  });
});
