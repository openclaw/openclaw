import { fromMarkdown, type CompileContext, type Extension } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { MentionTarget } from "./mention-target.types.js";

const FEISHU_LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?=[ \t])/u;
// `.` skips a carriage return, so the info string is matched as everything but the feed.
const FEISHU_FENCE_MARKER = /^(`{3,}|~{3,})([^\n]*)$/u;

/**
 * Whether a line is a fence marker behind any quote markers, list markers and indentation. This
 * only finds the markers a chunk must deliver whole and the chunks worth asking the parser about,
 * so how far a marker is indented does not matter here. A backtick fence carries no backtick in
 * its info string, which keeps an inline run in ordinary prose from reading as a marker, and a
 * tilde fence carries anything.
 */
function isFenceMarkerLine(line: string): boolean {
  let rest = line;
  for (;;) {
    rest = rest.replace(/^[ \t]+/u, "");
    if (rest.startsWith(">")) {
      rest = rest.slice(1);
      continue;
    }
    const list = FEISHU_LIST_MARKER.exec(rest);
    if (!list?.[0]) {
      break;
    }
    rest = rest.slice(list[0].length);
  }
  const marker = FEISHU_FENCE_MARKER.exec(rest);
  return Boolean(marker?.[1]) && !(marker?.[1]?.startsWith("`") && marker[2]?.includes("`"));
}

/**
 * A chunk that opens a fence nothing closes renders worse than the table it replaced, so the
 * conversion only runs when every chunk closes what it opened. Whether a line closes a fence
 * depends on every quote and list item around it, including a list the chunk opened before the
 * fence, and on what follows the marker, so the parser answers it rather than a second reading
 * of the rules. micromark emits one fence sequence for an opener and one for a closer, which
 * makes a code node with two of them a closed block. A chunk with no marker line has no fence to
 * ask about, which keeps the parse off ordinary prose.
 */
function fencesBalance(chunk: string): boolean {
  if (!chunk.split("\n").some(isFenceMarkerLine)) {
    return true;
  }
  const sequences = new Map<object, number>();
  parseFeishuMarkdown(chunk, {
    exit: {
      codeFencedFenceSequence(this: CompileContext) {
        const code = this.stack.toReversed().find((node) => node.type === "code");
        if (code) {
          sequences.set(code, (sequences.get(code) ?? 0) + 1);
        }
      },
    },
  });
  return [...sequences.values()].every((count) => count === 2);
}

/**
 * The zero-based lines that sit in a code block, fenced or indented, markers included. Table
 * conversion and routing read Markdown with HTML switched off, where a `<div>` line is plain text
 * and cannot take the fence after it, so this parse switches the HTML constructs off to agree with
 * them. Which character closes a fence, and at what length, is the parser's answer and not a
 * second one. The parser drops a leading byte order mark, which would shift its offsets, so the
 * text must already be trimmed.
 */
export function codeBlockLines(text: string): Set<number> {
  const lines = new Set<number>();
  // A code block needs a fence run or four columns of indentation, which prose seldom has.
  if (!/`{3}|~{3}|\t| {4}/u.test(text)) {
    return lines;
  }
  const root = fromMarkdown(text, {
    extensions: [gfmTable(), { disable: { null: ["htmlFlow", "htmlText"] } }],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  // Lines are counted from offsets. The parser's own line numbers also count a lone carriage
  // return, and a block its container ends stops at the start of the next line.
  const feeds: number[] = [];
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
    feeds.push(at);
  }
  const lineAt = (offset: number) => {
    let low = 0;
    let high = feeds.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((feeds[middle] ?? offset) < offset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  visitFeishuMarkdown(root, (node) => {
    if (node.type !== "code") {
      return;
    }
    const start = node.position?.start.offset ?? 0;
    const last = lineAt(Math.max(start, (node.position?.end.offset ?? text.length) - 1));
    for (let line = lineAt(start); line <= last; line += 1) {
      lines.add(line);
    }
  });
  return lines;
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

/**
 * One parser contract for Feishu message and document Markdown decisions. An observer extension
 * sees the same parse and changes nothing about it.
 */
export function parseFeishuMarkdown(text: string, ...observers: Extension[]): FeishuMarkdownNode {
  return fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown(), ...observers],
  }) as FeishuMarkdownNode;
}

export function visitFeishuMarkdown(
  root: FeishuMarkdownNode,
  visitor: (node: FeishuMarkdownNode) => void,
) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) {
      continue;
    }
    visitor(node);
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      const child = node.children?.[index];
      if (child) {
        pending.push(child);
      }
    }
  }
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
  visitFeishuMarkdown(root, (node) => {
    if (node.type !== "text") {
      return;
    }

    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) {
      return;
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
  });

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

/** Keep every platform chunk independently valid Markdown, including fences. */
export function chunkFeishuMarkdown(text: string, limit: number): string[] {
  return chunkMarkdownTextWithMode(text, limit, "length");
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
    chunkMarkdownTextWithMode(text, requestedLimit, params.mode ?? "length");
  const output: string[] = [];
  for (const initialChunk of initialChunks) {
    if (params.contentBytes(initialChunk, output.length === 0) <= FEISHU_POST_MAX_BYTES) {
      output.push(initialChunk);
      continue;
    }

    let adaptiveLimit = Math.max(1, Math.min(requestedLimit, initialChunk.length));

    while (true) {
      const chunks = chunkMarkdownTextWithMode(
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
