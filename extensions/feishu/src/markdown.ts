// Feishu-specific Markdown parsing and chunking.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

/**
 * A fence opener may carry an info string and a closer may not, and both sit behind the
 * table's source prefix. Quote markers pass, and so do the three spaces of indentation a
 * fence is allowed: a fourth makes the line indented code rather than a fence, which is
 * where the shared scanner draws the line too. Matching nothing else keeps an inline
 * backtick run in ordinary prose, and a backtick line inside an indented code block, from
 * reading as a marker and suppressing a table that would have converted safely. A closer
 * keeps the carriage return of a CRLF source, since the line split is on the feed alone.
 */
type FeishuFenceLine = {
  container: string;
  column: number;
  indent: number;
  marker: string;
  info: string;
};

const FEISHU_TAB_STOP = 4;
const FEISHU_LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t])/u;
// `.` skips a carriage return, so the info string is matched as everything but the feed.
const FEISHU_FENCE_MARKER = /^(`{3,}|~{3,})([^\n]*)$/u;

/**
 * Read the containers a line sits in before its marker run: quotes and list items, each
 * naming the block the fence belongs to, and the column where the content of that block
 * begins. A closer inside a list item carries no marker of its own, only the indentation
 * the item's content sits at, which is why the column is worth keeping.
 */
function readFenceLine(line: string): FeishuFenceLine | undefined {
  let index = 0;
  // A tab advances to the next stop of four, so indentation is counted in columns rather
  // than characters: one tab is the four that make a line indented code.
  let column = 0;
  let container = "";
  let indent = 0;
  // A quote or list marker takes the one column that follows it, so the content of the block
  // it opens starts there and the four that make indented code are counted from that column.
  // Every level is measured and the widest one settles the line, because four spaces before
  // the first marker are already indented code and a marker after them does not undo that.
  let markerColumn = 0;
  for (;;) {
    const columnStart = column;
    while (line[index] === " " || line[index] === "\t") {
      column =
        line[index] === "\t" ? column + FEISHU_TAB_STOP - (column % FEISHU_TAB_STOP) : column + 1;
      index += 1;
    }
    indent = Math.max(indent, column - columnStart - markerColumn);
    const rest = line.slice(index);
    if (rest.startsWith(">")) {
      container += ">";
      index += 1;
      column += 1;
      markerColumn = 1;
      continue;
    }
    const list = FEISHU_LIST_MARKER.exec(rest);
    if (!list?.[0]) {
      break;
    }
    container += "-";
    index += list[0].length;
    column += list[0].length;
    markerColumn = 1;
  }
  const marker = FEISHU_FENCE_MARKER.exec(line.slice(index));
  if (!marker?.[1]) {
    return undefined;
  }
  const info = marker[2] ?? "";
  // A backtick fence carries no backtick in its info string, which keeps an inline run in
  // ordinary prose from reading as a marker. A tilde fence carries anything, so a sample of
  // backticks inside one is content rather than a block of its own.
  if (marker[1].startsWith("`") && info.includes("`")) {
    return undefined;
  }
  return { container, column, indent, marker: marker[1], info };
}

/**
 * Four spaces before anything else is indented code, not a fence, which is where the shared
 * scanner draws the line too, and a quote or list marker after them does not change that.
 * Inside a list item the same four spaces are where the item's content starts, so a fence
 * opened by the item's own marker line is closed by a marker at that column, which is why a
 * line that cannot open one can still close it.
 */
function opensFence(line: FeishuFenceLine): boolean {
  if (line.indent > 3) {
    return false;
  }
  return line.container !== "" || line.column <= 3;
}

/**
 * Four spaces past the start of the block a line sits in are indented code on a closer the
 * same way they are on an opener, so a marker that far in is body text and the fence stays
 * open past it. The indentation a container's own markers carry is not the line's, which is
 * why the check reads the measured indent rather than the column; a closer with no marker of
 * its own carries the column its item's content starts at instead, and that is the width the
 * fence was opened at rather than any indentation the closer added.
 */
function closesFence(open: FeishuFenceLine, line: FeishuFenceLine): boolean {
  if (line.info.trim() !== "" || line.marker[0] !== open.marker[0]) {
    return false;
  }
  if (line.marker.length < open.marker.length) {
    return false;
  }
  if (line.container === open.container) {
    return line.indent <= 3;
  }
  return line.container === "" && line.column === open.column;
}

/**
 * A chunk that opens a fence nothing closes renders worse than the table it replaced, so
 * the conversion only runs when every chunk closes what it opened. A run shorter than the
 * one that opened the block is body text, which is how a cell carrying its own backticks
 * survives inside the longer marker the conversion gave it. A marker in a different
 * container is body text too: a quoted line inside a top-level block belongs to the block
 * and closes nothing.
 */
function fencesBalance(chunk: string): boolean {
  let open: FeishuFenceLine | undefined;
  for (const line of chunk.split("\n")) {
    const fence = readFenceLine(line);
    if (!fence) {
      continue;
    }
    if (!open) {
      if (opensFence(fence)) {
        open = fence;
      }
      continue;
    }
    if (closesFence(open, fence)) {
      open = undefined;
    }
  }
  return open === undefined;
}

function isFenceMarkerLine(line: string): boolean {
  return readFenceLine(line) !== undefined;
}

/**
 * `code` mode wraps each table in a fence, and the chunker closes and reopens that fence
 * at every boundary it cuts. It cannot do that for every shape. A cell's backticks
 * lengthen the marker, an indent widens the line the chunker has to fit twice, and a
 * quote prefix hides the marker from the fence scanner entirely, which no limit repairs.
 * Below a handful of characters the cut lands inside the marker and delivers backtick
 * fragments instead. Rather than model that budget, cut the converted text the way the
 * send will and ask three things of the pieces: each one stays inside the limit, each one
 * closes what it opened, and every marker arrives whole.
 */
export function fencesSurvive(converted: string, chunks: readonly string[]): boolean {
  if (!chunks.every(fencesBalance)) {
    return false;
  }
  const delivered = new Set(
    chunks.flatMap((chunk) => chunk.split("\n")).map((line) => line.trim()),
  );
  return converted
    .split("\n")
    .every((line) => !isFenceMarkerLine(line) || delivered.has(line.trim()));
}

export function chunkedFencesBalance(converted: string, limit: number, mode: ChunkMode): boolean {
  const chunks = chunkMarkdownTextWithMode(converted, limit, mode);
  return chunks.every((chunk) => chunk.length <= limit) && fencesSurvive(converted, chunks);
}

export type FeishuMarkdownNode = {
  type: string;
  depth?: number;
  identifier?: string;
  url?: string;
  position?: {
    start: { offset?: number };
    end: { offset?: number };
  };
  children?: FeishuMarkdownNode[];
};

type FeishuPostMessageElement =
  | { tag: "at"; user_id: string; user_name?: string }
  | { tag: "md"; text: string };

const FEISHU_POST_MAX_BYTES = 30 * 1024;

/** One parser contract for Feishu message and document Markdown decisions. */
export function parseFeishuMarkdown(text: string): FeishuMarkdownNode {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as FeishuMarkdownNode;
}

function buildFeishuPostMentionElements(mentions?: MentionTarget[]): FeishuPostMessageElement[] {
  if (!mentions?.length) {
    return [];
  }

  const elements: FeishuPostMessageElement[] = [];
  for (const mention of mentions) {
    const userId = mention.openId.trim();
    if (!userId) {
      continue;
    }
    const userName = mention.name.trim();
    elements.push({
      tag: "at",
      user_id: userId,
      ...(userName ? { user_name: userName } : {}),
    });
  }
  return elements;
}

export function buildFeishuPostMessageContent(params: {
  messageText: string;
  mentions?: MentionTarget[];
}): string {
  const content: FeishuPostMessageElement[] = [
    ...buildFeishuPostMentionElements(params.mentions),
    {
      tag: "md",
      text: params.messageText,
    },
  ];
  return JSON.stringify({
    zh_cn: {
      content: [content],
    },
  });
}

export function feishuPostWithinEnvelope(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= FEISHU_POST_MAX_BYTES;
}

export function assertFeishuPostWithinEnvelope(content: string, label: string): void {
  if (!feishuPostWithinEnvelope(content)) {
    throw new Error(`${label} exceeds the 30 KB rich-post API limit`);
  }
}

function collectSoftBreakOffsets(text: string): number[] {
  const root = parseFeishuMarkdown(text);
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
    const lineEnding = text[offset] === "\r" ? (text[offset + 1] === "\n" ? "\r\n" : "\r") : "\n";
    parts.push(text.slice(cursor, offset), "  ", lineEnding);
    cursor = offset + lineEnding.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function chunkFeishuMarkdownWithMode(text: string, limit: number, mode: ChunkMode): string[] {
  return chunkMarkdownTextWithMode(text, limit, mode);
}

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkFeishuMarkdownWithMode(text, limit, "length");
}

function postContentBytes(messageText: string, mentions?: MentionTarget[]): number {
  return Buffer.byteLength(buildFeishuPostMessageContent({ messageText, mentions }), "utf8");
}

/**
 * Honor both configured character chunking and Feishu's serialized post envelope.
 * Markdown wrappers and first-chunk mentions count toward the byte budget.
 */
export type FeishuMarkdownChunkOptions = {
  text: string;
  limit: number;
  mode?: ChunkMode;
  firstChunkMentions?: MentionTarget[];
  chunkMentions?: MentionTarget[];
  initialChunks?: string[];
};

export function chunkFeishuPostMarkdown(params: FeishuMarkdownChunkOptions): string[] {
  return chunkFeishuMarkdownByEnvelope({
    ...params,
    contentBytes: (text, isFirst) =>
      postContentBytes(text, [
        ...(params.chunkMentions ?? []),
        ...(isFirst ? (params.firstChunkMentions ?? []) : []),
      ]),
  });
}

/**
 * The post chunker owns its own envelope, so the size question is already settled and only
 * the markers are in doubt. A quote-prefixed marker is invisible to the fence scanner, so
 * a converted blockquoted table cannot be closed and reopened at a cut and its two markers
 * land in different messages.
 */
export function postFencesSurvive(converted: string, params: FeishuMarkdownChunkOptions): boolean {
  return fencesSurvive(converted, chunkFeishuPostMarkdown(params));
}

/** Measure the actual transport envelope, including UTF-8, JSON escapes and fence wrappers. */
export function chunkFeishuMarkdownByEnvelope(
  params: FeishuMarkdownChunkOptions & {
    contentBytes: (text: string, isFirst: boolean) => number;
  },
): string[] {
  const { text } = params;
  if (!text) {
    return [];
  }

  const requestedLimit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : text.length;
  const initialChunks =
    params.initialChunks ??
    chunkFeishuMarkdownWithMode(text, requestedLimit, params.mode ?? "length");
  const output: string[] = [];
  for (const initialChunk of initialChunks) {
    if (params.contentBytes(initialChunk, output.length === 0) <= FEISHU_POST_MAX_BYTES) {
      output.push(initialChunk);
      continue;
    }

    let adaptiveLimit = Math.max(1, Math.min(requestedLimit, initialChunk.length));

    while (true) {
      const chunks = chunkFeishuMarkdownWithMode(
        initialChunk,
        adaptiveLimit,
        params.mode ?? "length",
      );
      let largestContentBytes = 0;
      let oversizedChunk: string | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const contentBytes = params.contentBytes(chunk, output.length === 0 && index === 0);
        largestContentBytes = Math.max(largestContentBytes, contentBytes);
        if (contentBytes > FEISHU_POST_MAX_BYTES && oversizedChunk === undefined) {
          oversizedChunk = chunk;
        }
      }

      if (oversizedChunk === undefined) {
        output.push(...chunks);
        break;
      }
      if (adaptiveLimit === 1) {
        throw new Error("Feishu Markdown chunk exceeds the 30 KB API limit");
      }

      // Scale by the observed serialized size, then force progress for envelope
      // overhead or Markdown fence wrappers that do not shrink with source text.
      adaptiveLimit = Math.max(
        1,
        Math.min(
          adaptiveLimit - 1,
          Math.floor((adaptiveLimit * FEISHU_POST_MAX_BYTES) / largestContentBytes) - 1,
        ),
      );
    }
  }

  return output;
}
