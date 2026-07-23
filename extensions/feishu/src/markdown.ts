// Feishu-specific Markdown parsing and chunking.
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

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

// Feishu's OAPI rejects cards rendering more than 3 markdown tables with
// 230099 / sub-error 11310 "card table number over limit"; the retired
// official @larksuite plugin shipped the same measured cap. Exceeding it
// fails the whole send, so extra tables degrade to code blocks instead.
const FEISHU_CARD_TABLE_LIMIT = 3;

// Every GFM table has exactly one delimiter row built only from `|:- ` plus
// optional indent/blockquote prefixes, with at least one dash and one pipe,
// so this cheap line scan never undercounts real tables. It may overcount
// (fenced examples, ASCII art), which only means the precise parse below
// runs; card writes are throttled, so most streaming snapshots skip the
// full markdown parse here.
function countTableDelimiterLines(text: string): number {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.includes("|") && trimmed.includes("-") && /^[|:>\s-]+$/.test(trimmed)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Keep card markdown under Feishu's table limit by fencing the 4th+ table
 * as a code block. Fenced content no longer counts as a card table element,
 * so the send succeeds and the overflow tables stay readable as text.
 */
export function sanitizeFeishuCardMarkdownTables(text: string): string {
  if (countTableDelimiterLines(text) <= FEISHU_CARD_TABLE_LIMIT) {
    return text;
  }
  // Nested tables (inside lists/quotes) count toward the server-side limit
  // but cannot be fenced in place, so top-level tables absorb the overflow.
  // If nested tables alone exceed the limit the remainder stays unfenced.
  const topLevelTables: FeishuMarkdownNode[] = [];
  let nestedTableCount = 0;
  for (const child of parseFeishuMarkdown(text).children ?? []) {
    if (child.type === "table") {
      topLevelTables.push(child);
      continue;
    }
    const pending = [...(child.children ?? [])];
    while (pending.length > 0) {
      const node = pending.pop();
      if (node?.type === "table") {
        nestedTableCount += 1;
      } else if (node?.children) {
        pending.push(...node.children);
      }
    }
  }
  const overflow = topLevelTables.length + nestedTableCount - FEISHU_CARD_TABLE_LIMIT;
  if (overflow <= 0) {
    return text;
  }
  const fenceCount = Math.min(overflow, topLevelTables.length);
  let sanitized = text;
  // Fence the last tables first so earlier offsets stay valid and the
  // leading tables keep their native card rendering.
  for (const table of topLevelTables.slice(topLevelTables.length - fenceCount).toReversed()) {
    const start = table.position?.start.offset;
    const end = table.position?.end.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    sanitized = `${sanitized.slice(0, start)}\`\`\`\n${sanitized.slice(start, end)}\n\`\`\`${sanitized.slice(end)}`;
  }
  return sanitized;
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

export function assertFeishuPostWithinEnvelope(content: string, label: string): void {
  if (Buffer.byteLength(content, "utf8") > FEISHU_POST_MAX_BYTES) {
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
export function chunkFeishuPostMarkdown(params: {
  text: string;
  limit: number;
  mode?: ChunkMode;
  firstChunkMentions?: MentionTarget[];
  chunkMentions?: MentionTarget[];
  initialChunks?: string[];
}): string[] {
  const { text, firstChunkMentions, chunkMentions } = params;
  if (!text) {
    return [];
  }

  const requestedLimit =
    Number.isFinite(params.limit) && params.limit > 0 ? Math.floor(params.limit) : text.length;
  const initialChunks =
    params.initialChunks ??
    chunkFeishuMarkdownWithMode(text, requestedLimit, params.mode ?? "length");
  const output: string[] = [];
  const resolveMentions = (isFirst: boolean): MentionTarget[] | undefined => {
    const mentions = [...(chunkMentions ?? []), ...(isFirst ? (firstChunkMentions ?? []) : [])];
    return mentions.length > 0 ? mentions : undefined;
  };

  for (const initialChunk of initialChunks) {
    const mentions = resolveMentions(output.length === 0);
    if (postContentBytes(initialChunk, mentions) <= FEISHU_POST_MAX_BYTES) {
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
      let oversizedMentions: MentionTarget[] | undefined;

      for (const [index, chunk] of chunks.entries()) {
        const mentionsForChunk = resolveMentions(output.length === 0 && index === 0);
        const contentBytes = postContentBytes(chunk, mentionsForChunk);
        largestContentBytes = Math.max(largestContentBytes, contentBytes);
        if (contentBytes > FEISHU_POST_MAX_BYTES && oversizedChunk === undefined) {
          oversizedChunk = chunk;
          oversizedMentions = mentionsForChunk;
        }
      }

      if (oversizedChunk === undefined) {
        output.push(...chunks);
        break;
      }
      if (adaptiveLimit === 1) {
        assertFeishuPostWithinEnvelope(
          buildFeishuPostMessageContent({
            messageText: oversizedChunk,
            mentions: oversizedMentions,
          }),
          "Feishu post chunk",
        );
        return [...output, ...chunks];
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
