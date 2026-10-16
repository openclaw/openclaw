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

  it("reads a quoted marker past the quote's own four columns as indented code", () => {
    // Five spaces after the marker: one of them belongs to the marker, and the four that
    // remain make the rest indented code, so the line opens nothing and the table converts.
    const converted = convertMarkdownTables(`> note:\n>     \`\`\`\n>\n> end.\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });

  it("reads four spaces before a quote marker as the indented code they already are", () => {
    // The four spaces settle the line before the marker is reached, so the marker is content
    // and opens nothing, which leaves the generated table fences the only ones to balance.
    const converted = convertMarkdownTables(`    > \`\`\`\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });

  it("reads a quoted marker at three columns of content as the opener it is", () => {
    // Four spaces, one of them the marker's own, leave three, which still opens a block.
    const converted = convertMarkdownTables(`> note:\n>    \`\`\`\n>\n> end.\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(false);
  });

  it("measures a closer's indentation the way an opener's is measured", () => {
    // Four spaces make the rest of a line indented code wherever the block it sits in
    // begins, so the marker inside the top-level fence is content and the fence closes on
    // the last line rather than the indented one. The item's closer carries the four
    // spaces its content starts at, which is no indentation of its own, so it still
    // closes the fence its marker line opened.
    const authored = [
      "  - ```",
      "    sample",
      "    ```",
      "",
      "```",
      "sample",
      "    ```",
      "```",
    ].join("\n");
    const converted = convertMarkdownTables(`${authored}\n\n${table}`, "code");

    expect(chunkedFencesBalance(converted, 4_000, "length")).toBe(true);
  });
});

// micromark emits one fence sequence for an opener and one for a closer, and no default handler
// reads them, so counting them per code node says whether the parser closed that block.
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

/** Whether the production parser closes every fenced block it opens in this text. */
function parserClosesEveryFence(text: string): boolean {
  fenceSequences.clear();
  fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown(), fenceObserver],
  });
  return [...fenceSequences.values()].every((count) => count === 2);
}

/** Whether the production parser reads this text as exactly one code block that was closed. */
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

// The guard has to say what the parser says about a closer, because a chunk the guard passes is
// delivered as it stands. Every row names the verdict the parser gives, and the guard is held to
// the parser and to the row. The guard asks the parser itself, so the row is what pins the verdict
// by hand.
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
    // A list paragraph that came before the fence is part of what closes it.
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
    // Only spaces and tabs may follow a closing marker.
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

  // A limit small enough to cut the block. The chunker closes and reopens a fence it can see, so
  // a top-level one balances in every chunk, and it cannot see one behind a quote or a list
  // marker, so those leave a chunk with an opener and no closer.
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
        // The parser agrees on each chunk the guard saw.
        expect(chunks.every((chunk) => parserClosesEveryFence(chunk))).toBe(balanced);
      }
    },
  );

  it("converts a table after a nested block the guard used to refuse", () => {
    // The first block is properly closed, so the generated fence is the only one left to balance.
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
