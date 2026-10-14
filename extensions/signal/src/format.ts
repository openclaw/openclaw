import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  FormatCapabilityProfile,
  markdownToIR,
  type MarkdownIR,
  renderMarkdownWithAttributedRanges,
  renderMarkdownIRChunksWithinLimit,
  sliceMarkdownIR,
} from "openclaw/plugin-sdk/text-chunking";

type SignalTextStyle = "BOLD" | "ITALIC" | "STRIKETHROUGH" | "MONOSPACE" | "SPOILER";

export type SignalTextStyleRange = {
  start: number;
  length: number;
  style: SignalTextStyle;
};

export type SignalFormattedText = {
  text: string;
  styles: SignalTextStyleRange[];
};

type SignalMarkdownOptions = {
  tableMode?: MarkdownTableMode;
};

const SIGNAL_STYLE_MAP = {
  bold: "BOLD",
  italic: "ITALIC",
  strikethrough: "STRIKETHROUGH",
  code: "MONOSPACE",
  code_block: "MONOSPACE",
  spoiler: "SPOILER",
} as const;

const SIGNAL_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: {
    underline: "strip",
    codeLanguage: "fallback",
    linkLabel: "fallback",
    heading: "fallback",
    bulletList: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    blockquote: "fallback",
    image: "fallback",
    mention: "strip",
  },
  // Signal clients switch beyond 2 KiB bytes; byte-aware chunking remains an open question.
  chunk: { limit: 4_000, unit: "chars" },
});

function stripEquivalentSignalLinks(ir: MarkdownIR): MarkdownIR {
  const normalize = (value: string, preserveSuffixCase: boolean) => {
    const normalized = value
      .trim()
      .replace(/^(?:https?:\/\/)?(?:www\.)?/i, "")
      .replace(/\/+$/, "");
    // HTTP hosts ignore case, but paths, queries, and fragments can identify different targets.
    return preserveSuffixCase
      ? normalized.replace(/^[^/?#]+/, (host) => host.toLowerCase())
      : normalizeLowercaseStringOrEmpty(normalized);
  };
  // Core owns link suffixes; Signal retains its established normalized-URL de-duplication.
  return {
    ...ir,
    links: ir.links.filter((link) => {
      const label = ir.text.slice(link.start, link.end);
      const href = link.href.trim();
      const preserveSuffixCase = /^https?:\/\//i.test(href);
      return (
        normalize(label, preserveSuffixCase) !==
        normalize(href.replace(/^mailto:/, ""), preserveSuffixCase)
      );
    }),
  };
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const rendered = renderMarkdownWithAttributedRanges(
    stripEquivalentSignalLinks(ir),
    {
      styleMap: SIGNAL_STYLE_MAP,
      annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
      trimEnd: true,
    },
    SIGNAL_FORMAT_PROFILE,
  );
  return { text: rendered.text, styles: rendered.ranges };
}

function markdownToSignalIR(markdown: string, options: SignalMarkdownOptions): MarkdownIR {
  return markdownToIR(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "rich",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
}

export function markdownToSignalText(
  markdown: string,
  options: SignalMarkdownOptions = {},
): SignalFormattedText {
  return renderSignalText(markdownToSignalIR(markdown, options));
}

function splitSignalIRForChunkMode(
  ir: MarkdownIR,
  limit: number,
  chunkMode: ChunkMode,
): MarkdownIR[] {
  if (chunkMode !== "newline") {
    return [ir];
  }
  const chunks: MarkdownIR[] = [];
  let cursor = 0;
  for (const text of chunkMarkdownTextWithMode(ir.text, limit, chunkMode)) {
    const start = ir.text.indexOf(text, cursor);
    if (start < 0) {
      return [ir];
    }
    cursor = start + text.length;
    chunks.push(sliceMarkdownIR(ir, start, cursor));
  }
  return chunks;
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions & { chunkMode?: ChunkMode } = {},
): SignalFormattedText[] {
  const ir = markdownToSignalIR(markdown, options);
  // Signal uses public list markers; private source coordinates are only needed by block renderers.
  if (ir.listItems && ir.text.length > limit) {
    ir.listItems = ir.listItems.map((item) => ({ ...item }));
  }
  return splitSignalIRForChunkMode(ir, limit, options.chunkMode ?? "length").flatMap((source) =>
    renderMarkdownIRChunksWithinLimit({
      ir: source,
      limit,
      assistantTranscriptRoleMessageBoundaries: true,
      renderChunk: renderSignalText,
      measureRendered: (rendered) => rendered.text.length,
    }).map(({ rendered }) => rendered),
  );
}
