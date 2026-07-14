// Feishu-specific Markdown parsing and chunking.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode } from "openclaw/plugin-sdk/reply-chunking";

type PositionedMarkdownNode = {
  type: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: PositionedMarkdownNode[];
};

function collectSoftBreakOffsets(text: string): number[] {
  const root = fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as PositionedMarkdownNode;
  const offsets: number[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    if (node.children) {
      pending.push(...node.children);
    }
    if (node.type !== "text") {
      continue;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    for (let offset = start; offset < end; offset += 1) {
      const char = text[offset];
      if (char === "\n") {
        if (text[offset - 1] !== "\r") {
          offsets.push(offset);
        }
        continue;
      }
      if (char === "\r") {
        offsets.push(offset);
        if (text[offset + 1] === "\n") {
          offset += 1;
        }
      }
    }
  }

  return offsets.toSorted((left, right) => left - right);
}

/**
 * Materialize CommonMark soft breaks for Feishu post `md` rendering.
 *
 * The parser identifies only soft breaks, then upgrades them to CommonMark
 * hard breaks. Structural line endings and code, HTML, definitions, setext
 * headings, and existing hard breaks retain their source bytes.
 */
export function materializeFeishuPostMarkdownSoftBreaks(text: string): string {
  if (!text.includes("\n") && !text.includes("\r")) {
    return text;
  }

  const softBreakOffsets = collectSoftBreakOffsets(text);
  if (softBreakOffsets.length === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const offset of softBreakOffsets) {
    const lineEnding = text[offset] === "\r" && text[offset + 1] === "\n" ? "\r\n" : text[offset];
    parts.push(text.slice(cursor, offset), "  ", lineEnding);
    cursor = offset + lineEnding.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkMarkdownTextWithMode(text, limit, "length");
}
