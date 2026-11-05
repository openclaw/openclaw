import { describe, expect, it } from "vitest";
import { inputRichBlocksToPlainText } from "./rich-block-model.js";
import { markdownToTelegramRichBlocks } from "./rich-blocks.js";

const table = "| Brand | Status |\n|---|---|\n| Acme | waiting |";
const quotedTable = `> ${table.replaceAll("\n", "\n> ")}`;
const tableBlock = { type: "table" };
const quoteBlock = { type: "blockquote", blocks: [{ type: "paragraph" }] };
const listBlock = { type: "list", items: [{ blocks: [{ type: "paragraph" }] }] };

describe("native table block boundaries", () => {
  it.each([
    {
      name: "table then blockquote",
      markdown: `${table}\n\n> After`,
      blocks: [tableBlock, quoteBlock],
    },
    {
      name: "table then list",
      markdown: `${table}\n\n- After`,
      blocks: [tableBlock, listBlock],
    },
    {
      name: "blockquote then table",
      markdown: `> Before\n\n${table}`,
      blocks: [quoteBlock, tableBlock],
    },
    {
      name: "table then paragraph",
      markdown: `${table}\n\nAfter`,
      blocks: [tableBlock, { type: "paragraph" }],
    },
    {
      name: "list then table",
      markdown: `- Before\n\n${table}`,
      blocks: [listBlock, tableBlock],
    },
    {
      name: "table then heading",
      markdown: `${table}\n\n# After`,
      blocks: [tableBlock, { type: "heading" }],
    },
    {
      name: "table then code",
      markdown: `${table}\n\n\`\`\`\nAfter\n\`\`\``,
      blocks: [tableBlock, { type: "pre" }],
    },
    {
      name: "table-only quote then separate quote",
      markdown: `${quotedTable}\n\n> After`,
      blocks: [{ type: "blockquote", blocks: [tableBlock] }, quoteBlock],
    },
    {
      name: "trailing table in quote",
      markdown: `> Before\n>\n${quotedTable}`,
      blocks: [{ type: "blockquote", blocks: [{ type: "paragraph" }, tableBlock] }],
    },
    {
      name: "trailing table in list",
      markdown: `- Before\n\n  ${table.replaceAll("\n", "\n  ")}`,
      blocks: [{ type: "list", items: [{ blocks: [{ type: "paragraph" }, tableBlock] }] }],
    },
  ])("preserves $name without losing content", ({ markdown, blocks }) => {
    const result = markdownToTelegramRichBlocks(markdown);
    expect(result.blocks).toMatchObject(blocks);
    expect(result.degradationReasons).toEqual([]);
    const words = markdown.includes("Before")
      ? ["Before", "Brand", "Status", "Acme", "waiting"]
      : ["Brand", "Status", "Acme", "waiting", "After"];
    for (const text of [inputRichBlocksToPlainText(result.blocks), result.plainText]) {
      expect(text.match(/[A-Za-z]+/g)).toEqual(words);
    }
  });
});
