import { expectDefined } from "@openclaw/normalization-core/expect";
import { getMarkdownTableSource, markdownToIRWithMeta } from "./ir.js";
import { renderMarkdownCodeTable, renderMarkdownTableBullets } from "./table-layout.js";
import type { MarkdownTableMode } from "./types.js";

/** Convert only parsed table ranges; unrelated Markdown retains its original source bytes. */
export function convertMarkdownTables(markdown: string, mode: MarkdownTableMode): string {
  if (!markdown || mode === "off" || !markdown.includes("|")) {
    return markdown;
  }
  const { tables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    tableMode: "block",
  });
  let cursor = 0;
  let result = "";
  for (const table of tables) {
    const source = expectDefined(getMarkdownTableSource(table), "Markdown table source");
    let rendered = "";
    if (mode !== "bullets") {
      const text = renderMarkdownCodeTable(table.headers, table.rows);
      let fenceLength = 3;
      for (const run of text.matchAll(/`+/g)) {
        fenceLength = Math.max(fenceLength, run[0].length + 1);
      }
      const fence = "`".repeat(fenceLength);
      rendered = `${fence}\n${text}${fence}`;
    } else {
      const headers = table.headers.map((text, column) => ({
        text,
        markdown: source.headers[column],
      }));
      const rows = table.rows.map((row, index) =>
        row.map((text, column) => ({ text, markdown: source.rows[index]?.[column] })),
      );
      renderMarkdownTableBullets(
        headers,
        rows,
        (text) => {
          rendered += text;
        },
        (cell, rowLabel) => {
          rendered += rowLabel ? `**${cell.markdown}**` : cell.markdown;
        },
      );
      rendered = rendered.replace(/\n+$/u, "");
    }
    rendered = rendered.replaceAll("\n", "\n" + source.prefix);
    result += markdown.slice(cursor, source.start) + rendered;
    cursor = source.end;
  }
  return result + markdown.slice(cursor);
}
