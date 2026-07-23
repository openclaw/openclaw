// Signal helper module supports format behavior.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  markdownToIR,
  type MarkdownIR,
  renderMarkdownWithAttributedRanges,
  renderMarkdownIRChunksWithinLimit,
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

function normalizeUrlForComparison(url: string): string {
  let normalized = normalizeLowercaseStringOrEmpty(url);
  // Strip protocol
  normalized = normalized.replace(/^https?:\/\//, "");
  // Strip www. prefix
  normalized = normalized.replace(/^www\./, "");
  // Strip trailing slashes
  normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function renderSignalText(ir: MarkdownIR): SignalFormattedText {
  const rendered = renderMarkdownWithAttributedRanges(ir, {
    styleMap: SIGNAL_STYLE_MAP,
    annotationStyleMap: { assistant_transcript_role: "MONOSPACE" },
    trimEnd: true,
    renderLink: (link, text) => {
      const href = link.href.trim();
      const trimmedLabel = text.slice(link.start, link.end).trim();
      if (!href || !trimmedLabel) {
        return href;
      }
      const comparableHref = href.startsWith("mailto:") ? href.slice("mailto:".length) : href;
      return normalizeUrlForComparison(trimmedLabel) === normalizeUrlForComparison(comparableHref)
        ? ""
        : ` (${href})`;
    },
  });
  return { text: rendered.text, styles: rendered.ranges };
}

export function markdownToSignalText(
  markdown: string,
  options: SignalMarkdownOptions = {},
): SignalFormattedText {
  const ir = markdownToIR(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderSignalText(ir);
}

export function markdownToSignalTextChunks(
  markdown: string,
  limit: number,
  options: SignalMarkdownOptions = {},
): SignalFormattedText[] {
  const ir = markdownToIR(markdown ?? "", {
    assistantTranscriptRoleHeaders: true,
    linkify: true,
    enableSpoilers: true,
    headingStyle: "bold",
    blockquotePrefix: "> ",
    tableMode: options.tableMode,
  });
  return renderMarkdownIRChunksWithinLimit({
    ir,
    limit,
    assistantTranscriptRoleMessageBoundaries: true,
    renderChunk: renderSignalText,
    measureRendered: (rendered) => rendered.text.length,
  }).map(({ rendered }) => rendered);
}
