import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
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
  chunkMode?: ChunkMode;
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

function chunkSignalIRByParagraph(ir: MarkdownIR, limit: number): MarkdownIR[] {
  const codeSpans = ir.styles.filter(
    (span) => span.style === "code" || span.style === "code_block",
  );
  const paragraphs: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of ir.text.matchAll(/\n[\t ]*\n+/g)) {
    const end = match.index + match[0].length;
    // IR has no fence delimiters: its parsed spans own internal code blank lines.
    // A separator extending past the code span is the following block boundary.
    if (codeSpans.some((span) => span.start <= match.index && end <= span.end)) {
      continue;
    }
    if (match.index > start) {
      paragraphs.push({ start, end: match.index });
    }
    start = end;
  }
  if (start < ir.text.length) {
    paragraphs.push({ start, end: ir.text.length });
  }

  const chunks: MarkdownIR[] = [];
  let pending: { start: number; end: number } | undefined;
  for (const paragraph of paragraphs) {
    if (
      pending &&
      renderSignalText(sliceMarkdownIR(ir, pending.start, paragraph.end)).text.length <= limit
    ) {
      pending.end = paragraph.end;
    } else {
      if (pending) {
        chunks.push(sliceMarkdownIR(ir, pending.start, pending.end));
      }
      pending = paragraph;
    }
  }
  if (pending) {
    chunks.push(sliceMarkdownIR(ir, pending.start, pending.end));
  }
  return chunks;
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions = {},
): SignalFormattedText[] {
  const ir = markdownToSignalIR(markdown, options);
  // Signal uses public list markers; private source coordinates are only needed by block renderers.
  if (ir.listItems && ir.text.length > limit) {
    ir.listItems = ir.listItems.map((item) => ({ ...item }));
  }
  const chunks = options.chunkMode === "newline" ? chunkSignalIRByParagraph(ir, limit) : [ir];
  return chunks.flatMap((chunk) =>
    renderMarkdownIRChunksWithinLimit({
      ir: chunk,
      limit,
      assistantTranscriptRoleMessageBoundaries: true,
      renderChunk: renderSignalText,
      measureRendered: (rendered) => rendered.text.length,
    }).map(({ rendered }) => rendered),
  );
}
