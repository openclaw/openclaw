import {
  applyMarkdownTextEdits,
  FormatCapabilityProfile,
  markdownToIR,
  renderMarkdownWithAttributedRanges,
} from "openclaw/plugin-sdk/text-chunking";

type IMessageFormatStyle = "bold" | "italic" | "underline" | "strikethrough";

type IMessageFormatRange = {
  start: number;
  length: number;
  styles: IMessageFormatStyle[];
};

const IMESSAGE_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "ranges",
  constructs: {
    spoiler: "strip",
    codeInline: "fallback",
    codeBlock: "fallback",
    codeLanguage: "strip",
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
  chunk: { limit: 4_000, unit: "utf16" },
});

const IMESSAGE_CODE_PROFILE = FormatCapabilityProfile.define({
  ...IMESSAGE_FORMAT_PROFILE,
  constructs: { ...IMESSAGE_FORMAT_PROFILE.constructs, codeInline: "native" },
});

const IMESSAGE_STYLE_MAP = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  strikethrough: "strikethrough",
} as const;

function codeDelimiter(content: string): string {
  const longestRun = Math.max(0, ...[...content.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(longestRun + 1);
}

function restoreCodeMarkers(
  text: string,
  ranges: Array<{ start: number; length: number; styles: IMessageFormatStyle[] }>,
  codeRanges: Array<{ start: number; length: number }>,
): { text: string; ranges: IMessageFormatRange[] } {
  if (codeRanges.length === 0) {
    return { text, ranges };
  }
  const edits = codeRanges.map((range) => {
    const end = range.start + range.length;
    const content = text.slice(range.start, end);
    const marker = codeDelimiter(content);
    const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return { start: range.start, end, text: `${marker}${padding}${content}${padding}${marker}` };
  });
  const { text: rendered, mapOffset } = applyMarkdownTextEdits(text, edits);
  return {
    text: rendered,
    ranges: ranges.map((range) => {
      const start = mapOffset(range.start);
      return { ...range, start, length: mapOffset(range.start + range.length) - start };
    }),
  };
}

export function extractMarkdownFormatRuns(input: string): {
  text: string;
  ranges: IMessageFormatRange[];
} {
  const ir = markdownToIR(input, {
    autolink: false,
    enableHtmlUnderline: true,
    headingStyle: "rich",
    linkify: false,
    preserveDunderIdentifiers: true,
    preserveSourceBlockSpacing: true,
  });
  const rendered = renderMarkdownWithAttributedRanges(
    ir,
    { styleMap: IMESSAGE_STYLE_MAP },
    IMESSAGE_FORMAT_PROFILE,
  );
  // Fallback projection can shift inline-code spans, but never creates them.
  const codeRanges = ir.styles.some((span) => span.style === "code")
    ? renderMarkdownWithAttributedRanges(ir, { styleMap: { code: "code" } }, IMESSAGE_CODE_PROFILE)
        .ranges
    : [];
  return restoreCodeMarkers(
    rendered.text,
    rendered.ranges.map(({ start, length, style }) => ({
      start,
      length,
      styles: [style],
    })),
    codeRanges,
  );
}
