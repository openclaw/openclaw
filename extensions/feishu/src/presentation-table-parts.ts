// Feishu plugin module cuts presentation text into card elements, around native tables.
import { getMarkdownTableSource } from "openclaw/plugin-sdk/markdown-table-runtime";
import { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { chunkFeishuMarkdown } from "./markdown.js";

/**
 * The shared adapter splits a block to the text limit above before this module sees it,
 * and `code` mode then pads every cell and adds a fence, so a block that arrived inside
 * the limit can leave it. Split the projected form back, with the chunker that closes and
 * reopens a fence rather than cutting one in half, and give each piece its own element.
 */
// The element carries the escaped text, and escaping turns one `&`, `<` or `>` into four
// or five characters after the cut has already been made. Cutting the escaped text
// instead would split an entity, so the budget comes down from the limit by whatever the
// longest part actually measured, until the escaped parts fit.
export function fitBlockParts(
  text: string,
  ceiling: number,
  encodeText: (text: string) => string,
): string[] {
  let budget = ceiling;
  let parts = chunkFeishuMarkdown(text, budget);
  for (let attempt = 0; attempt < 8 && parts.length > 0; attempt += 1) {
    const longest = Math.max(...parts.map((part) => encodeText(part).length));
    if (longest <= ceiling) {
      return parts;
    }
    const next = Math.floor((budget * ceiling) / longest);
    if (next < 1 || next >= budget) {
      break;
    }
    budget = next;
    parts = chunkFeishuMarkdown(text, budget);
  }
  return parts;
}

/**
 * A card draws a table from its header and delimiter, so a piece of a table that starts on a
 * data row shows raw pipes. A table too long for one element is therefore cut into pieces that
 * each repeat the header and delimiter, inside a fence so the card does not count every piece
 * against its five-table limit. A cell's backticks lengthen the fence the way the code
 * conversion lengthens its own. Returns undefined when a header and one row cannot share a piece.
 */
function repeatHeaderInFence(table: string, fits: (text: string) => boolean): string[] | undefined {
  const [header = "", delimiter = "", ...rows] = table.split("\n");
  const longestRun = Math.max(0, ...(table.match(/`+/gu) ?? []).map((ticks) => ticks.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  const wrap = (lines: string) => `${fence}\n${lines}\n${fence}`;
  const head = `${header}\n${delimiter}`;
  const pieces: string[] = [];
  let body = head;
  let filled = false;
  for (const row of rows) {
    if (filled && !fits(wrap(`${body}\n${row}`))) {
      pieces.push(wrap(body));
      body = head;
    }
    body = `${body}\n${row}`;
    filled = true;
  }
  pieces.push(wrap(body));
  return pieces.every(fits) ? pieces : undefined;
}

/**
 * Cut `text` the way `cut` does, then look for a table the cut went through. A table that fits
 * one element is taken out whole and the text around it is cut on its own, so it keeps its header
 * with its rows. A table that does not fit is cut by the repeated header above, and `cut` is the
 * last resort when even that cannot carry it. Text no cut goes through comes back exactly as `cut`
 * made it.
 */
export function cutKeepingTables(
  text: string,
  fits: (text: string) => boolean,
  cut: (text: string) => string[],
): string[] {
  if (!text.trim()) {
    return [];
  }
  if (fits(text)) {
    return [text];
  }
  const parts = cut(text);
  // Parts are in order, so the cursor tells two identical tables apart.
  let cursor = 0;
  const placed = parts.map((part) => {
    const at = text.indexOf(part, cursor);
    cursor = at < 0 ? cursor : at + part.length;
    return { at, part };
  });
  const tables = text.includes("|")
    ? markdownToIRWithMeta(text, { tableMode: "block" }).tables
    : [];
  for (const meta of tables) {
    const source = getMarkdownTableSource(meta);
    if (!source) {
      continue;
    }
    const table = text.slice(source.start, source.end);
    const whole = placed.some(({ at, part }) =>
      at < 0 ? part.includes(table) : at <= source.start && at + part.length >= source.end,
    );
    if (whole) {
      continue;
    }
    return [
      ...cutKeepingTables(text.slice(0, source.start).replace(/(?:\r?\n)+$/u, ""), fits, cut),
      ...(fits(table) ? [table] : (repeatHeaderInFence(table, fits) ?? cut(table))),
      ...cutKeepingTables(text.slice(source.end).replace(/^(?:\r?\n)+/u, ""), fits, cut),
    ];
  }
  return parts;
}
