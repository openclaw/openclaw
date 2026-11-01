import { fromMarkdown, type CompileContext } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { convertMarkdownTables } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";
import { describe, expect, it } from "vitest";
import {
  buildFeishuPostMessageContent,
  chunkedFencesBalance,
  chunkFeishuPostMarkdown,
  fencesSurvive,
  materializeFeishuPostMarkdownSoftBreaks,
  parseFeishuMarkdown,
  visitFeishuMarkdown,
} from "./markdown.js";

describe("materializeFeishuPostMarkdownSoftBreaks", () => {
  it.each([
    { name: "CRLF", input: "line one\r\nline two", expected: "line one  \r\nline two" },
    { name: "CR", input: "line one\rline two", expected: "line one  \rline two" },
  ])("materializes CommonMark soft breaks with $name endings", ({ input, expected }) => {
    expect(materializeFeishuPostMarkdownSoftBreaks(input)).toBe(expected);
  });
});

describe("chunkedFencesBalance", () => {
  const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";

  it.each([
    {
      name: "a quoted marker past four columns",
      authored: "> note:\n>     ```\n>\n> end.",
      balanced: true,
    },
    { name: "four spaces before a quote marker", authored: "    > ```", balanced: true },
    {
      name: "a quoted marker at three columns",
      authored: "> note:\n>    ```\n>\n> end.",
      balanced: false,
    },
    {
      name: "a closer measured like its opener",
      authored: ["  - ```", "    sample", "    ```", "", "```", "sample", "    ```", "```"].join(
        "\n",
      ),
      balanced: true,
    },
  ])("reads $name before a converted table (balanced: $balanced)", ({ authored, balanced }) => {
    const converted = convertMarkdownTables(`${authored}\n\n${table}`, "code");
    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(balanced);
  });

  // The conversion and a card read a tag line as prose, so it cannot hide the fence after it.
  it.each(["", "<div>\n"])("refuses a cut through a list table's fence after %j", (lead) => {
    const rows = Array.from({ length: 160 }, (_row, i) => `    | row-${i} | value-${i} |`);
    const converted = convertMarkdownTables(
      `${lead}  - | A | B |\n    | --- | --- |\n${rows.join("\n")}`,
      "code",
    );
    for (const mode of ["length", "newline"] as const) {
      const chunks = chunkMarkdownTextWithMode(converted, 4_000, mode);
      expect(chunks).toHaveLength(2);
      expect(chunks[0]).toContain("  - ```\n");
      expect(chunks[1]).toMatch(/\n {4}```$/u);
      expect(chunkedFencesBalance(converted, 4_000, mode)).toBe(false);
    }
  });
});

const fenceSequences = new Map<object, number>();
const fenceObserver = {
  exit: {
    codeFencedFenceSequence(this: CompileContext) {
      const node = this.stack.toReversed().find((entry) => entry.type === "code");
      if (node) {
        fenceSequences.set(node, (fenceSequences.get(node) ?? 0) + 1);
      }
    },
  },
};

function parserClosesEveryFence(text: string): boolean {
  fenceSequences.clear();
  fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown(), fenceObserver],
  });
  return [...fenceSequences.values()].every((count) => count === 2);
}

function parserYieldsOneClosedBlock(text: string): boolean {
  fenceSequences.clear();
  fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown(), fenceObserver],
  });
  let codeNodes = 0;
  visitFeishuMarkdown(parseFeishuMarkdown(text), (node) => {
    codeNodes += node.type === "code" ? 1 : 0;
  });
  const sequences = [...fenceSequences.values()];
  return codeNodes === 1 && sequences.length === 1 && sequences[0] === 2;
}

describe("fence guard against the Markdown parser", () => {
  const F = "```";
  const cases = [
    { name: "a quote", lines: [`> ${F}`, "> x", `> ${F}`], closed: true },
    { name: "a list", lines: [`- ${F}`, "  x", `  ${F}`], closed: true },
    { name: "a quote then a list", lines: [`> - ${F}`, ">   x", `>   ${F}`], closed: true },
    { name: "a list then a quote", lines: [`- > ${F}`, "  > x", `  > ${F}`], closed: true },
    {
      name: "two quotes then a list",
      lines: [`> > - ${F}`, "> >   x", `> >   ${F}`],
      closed: true,
    },
    {
      name: "a quote then two lists",
      lines: [`> - - ${F}`, ">     x", `>     ${F}`],
      closed: true,
    },
    {
      name: "a quote, a list, a quote",
      lines: [`> - > ${F}`, ">   > x", `>   > ${F}`],
      closed: true,
    },
    {
      name: "shifted indentation with a look-alike closer",
      lines: [`   >    > - ${F}`, "   >    >   x", `> >         ${F}`],
      closed: false,
    },
    {
      name: "shifted indentation, look-alike, then the real closer",
      lines: [
        `   >    > - ${F}`,
        "   >    >   x",
        `> >         ${F}`,
        "   >    >   y",
        `   >    >   ${F}`,
      ],
      closed: true,
    },
    {
      name: "a bare closer after a quoted opener",
      lines: [`> ${F}`, "> x", `  ${F}`],
      closed: false,
    },
    {
      name: "a bare closer after a quote and list opener",
      lines: [`> - ${F}`, ">   x", `    ${F}`],
      closed: false,
    },
    {
      name: "an outer quote moved past a list",
      lines: [`- > ${F}`, "  > x", `>   ${F}`],
      closed: false,
    },
    {
      name: "a quote moved in from the margin",
      lines: [`> - ${F}`, ">   x", `  > ${F}`],
      closed: false,
    },
    {
      name: "a nested quote moved left",
      lines: [`> - > ${F}`, ">   > x", `> >   ${F}`],
      closed: false,
    },
    {
      name: "an indented look-alike closer inside the body",
      lines: [`> - ${F}`, ">   x", `>         ${F}`, ">   y", `>   ${F}`],
      closed: true,
    },
    {
      name: "a list closed by a bare continuation marker",
      lines: [`1. ${F}`, "   x", `      ${F}`],
      closed: true,
    },
    {
      name: "a list closer past three columns of continuation",
      lines: [`1. ${F}`, "   x", `       ${F}`],
      closed: false,
    },
    {
      name: "a repeated list marker, which starts a new item",
      lines: [`- ${F}`, "  x", `- ${F}`],
      closed: false,
    },
    {
      name: "a quote marker three columns in",
      lines: [`> ${F}`, "> x", `   > ${F}`],
      closed: true,
    },
    {
      name: "a quote marker four columns in",
      lines: [`> ${F}`, "> x", `    > ${F}`],
      closed: false,
    },
    { name: "a longer tilde closer", lines: ["> ~~~", "> x", "> ~~~~"], closed: true },
    { name: "a closer shorter than its opener", lines: ["> ````", "> x", `> ${F}`], closed: false },
    {
      name: "a quote-only line inside a list item",
      lines: [`> - ${F}`, ">   x", ">", `>   ${F}`],
      closed: true,
    },
    {
      name: "an empty line that ends the quote",
      lines: [`> ${F}`, "> x", "", `> ${F}`],
      closed: false,
    },
    {
      name: "a body line that leaves the quote",
      lines: [`> ${F}`, "> x", "y", `> ${F}`],
      closed: false,
    },
    {
      name: "a quote inside a list item that is already open",
      lines: ["- item", `  > ${F}`, "    > x", `  > ${F}`],
      closed: true,
    },
    {
      name: "the same quote with its body at the quote's own column",
      lines: ["- item", `  > ${F}`, "  > x", `  > ${F}`],
      closed: true,
    },
    {
      name: "a closer that leaves the list item that is already open",
      lines: ["- item", `  > - ${F}`, "  >   x", `>   ${F}`],
      closed: false,
    },
    {
      name: "an ordered list item that is already open",
      lines: ["1. item", `   > ${F}`, "   > x", `   > ${F}`],
      closed: true,
    },
    {
      name: "a fence after a continuation line of the open item",
      lines: ["- item", "  more", `  ${F}`, "  x", `  ${F}`],
      closed: true,
    },
    {
      name: "a closer that leaves an ordered list item that is already open",
      lines: ["1. item", `   > ${F}`, "   > x", `> ${F}`],
      closed: false,
    },
    {
      name: "a no-break space after the closer",
      lines: [`- ${F}`, "  x", `   ${F}\u00a0`],
      closed: false,
    },
    {
      name: "a no-break space after the closer, then the real one",
      lines: [`- ${F}`, "  x", `   ${F}\u00a0`, "  y", `  ${F}`],
      closed: true,
    },
    { name: "a space after the closer", lines: [`- ${F}`, "  x", `   ${F} `], closed: true },
    {
      name: "spaces and a tab after the closer",
      lines: [`> ${F}`, "> x", `> ${F}  \t `],
      closed: true,
    },
    {
      name: "an em space after the closer",
      lines: [`> ${F}`, "> x", `> ${F}\u2003`],
      closed: false,
    },
    {
      name: "an ideographic space after the closer",
      lines: [`> ${F}`, "> x", `> ${F}\u3000`],
      closed: false,
    },
    {
      name: "a zero width space after the closer",
      lines: [`> ${F}`, "> x", `> ${F}\u200b`],
      closed: false,
    },
    {
      name: "a no-break space after a tilde closer",
      lines: ["~~~", "x", "~~~\u00a0"],
      closed: false,
    },
  ];

  it.each(cases)("agrees with the parser on $name", ({ lines, closed }) => {
    for (const eol of ["\n", "\r\n"]) {
      const text = lines.join(eol);
      expect(parserYieldsOneClosedBlock(text)).toBe(closed);
      expect(fencesSurvive(text, [text])).toBe(closed);
      expect(chunkedFencesBalance(text, 4_000, "length")).toBe(closed);
      expect(chunkedFencesBalance(text, 4_000, "newline")).toBe(closed);
    }
  });

  it.each([
    { name: "a top-level fence", prefix: "", cut: true, balanced: true },
    { name: "a quoted fence", prefix: "> ", cut: true, balanced: false },
    { name: "a list fence", prefix: "- ", cut: true, balanced: false },
    { name: "a quoted fence that fits one chunk", prefix: "> ", cut: false, balanced: true },
  ])(
    "cuts $name at a small limit and the guard follows the chunks",
    ({ prefix, cut, balanced }) => {
      const lines = [
        `${prefix}${F}`,
        ...["a", "b", "c", "d", "e", "f"]
          .map((line) => line.repeat(8))
          .map((line) => `${prefix.replace("-", " ")}${line}`),
      ];
      const text = [...lines, `${prefix.replace("-", " ")}${F}`].join("\n");
      for (const mode of ["length", "newline"] as const) {
        const limit = cut ? 20 : 4_000;
        const chunks = chunkMarkdownTextWithMode(text, limit, mode);
        expect(chunks.length > 1).toBe(cut);
        expect(chunkedFencesBalance(text, limit, mode)).toBe(balanced);
        expect(chunks.every((chunk) => parserClosesEveryFence(chunk))).toBe(balanced);
      }
    },
  );

  it("converts a table after a nested block the guard used to refuse", () => {
    const authored = `   >    > - ${F}\n   >    >   x\n> >         ${F}\n   >    >   y\n   >    >   ${F}`;
    const converted = convertMarkdownTables(
      `${authored}\n\n| a | b |\n| --- | --- |\n| 1 | 2 |`,
      "code",
    );

    expect(converted.endsWith(`${F}\n| a   | b   |\n| --- | --- |\n| 1   | 2   |\n${F}`)).toBe(
      true,
    );
    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
    expect(chunkedFencesBalance(converted, 4_000, "newline")).toBe(true);
  });
});

describe("chunkFeishuPostMarkdown", () => {
  it("reserves the first chunk byte budget for native mentions and multibyte text", () => {
    const mentions = [
      {
        openId: "ou_target",
        name: "界".repeat(1_000),
        key: "@_user_1",
      },
    ];
    const chunks = chunkFeishuPostMarkdown({
      text: "界".repeat(11_000),
      limit: 25_000,
      firstChunkMentions: mentions,
    });

    expect(chunks.length).toBeGreaterThan(1);
    for (const [index, chunk] of chunks.entries()) {
      const content = buildFeishuPostMessageContent({
        messageText: chunk,
        mentions: index === 0 ? mentions : undefined,
      });
      expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(30 * 1024);
    }
  });
});
