import {
  applyMarkdownTextEdits,
  FormatCapabilityProfile,
  markdownToIR,
  renderMarkdownWithAttributedRanges,
} from "openclaw/plugin-sdk/text-chunking";

type IMessageFormatRange = {
  start: number;
  length: number;
  styles: ("bold" | "italic" | "underline" | "strikethrough")[];
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
  const text = rendered.text;
  const ranges: IMessageFormatRange[] = rendered.ranges.map(({ start, length, style }) => ({
    start,
    length,
    styles: [style],
  }));
  if (codeRanges.length === 0) {
    return { text, ranges };
  }
  const edits = codeRanges.map((range) => {
    const end = range.start + range.length;
    const content = text.slice(range.start, end);
    const longestRun = Math.max(
      0,
      ...[...content.matchAll(/`+/gu)].map((match) => match[0].length),
    );
    const marker = "`".repeat(longestRun + 1);
    const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
    return { start: range.start, end, text: `${marker}${padding}${content}${padding}${marker}` };
  });
  const { text: restoredText, mapOffset } = applyMarkdownTextEdits(text, edits);
  return {
    text: restoredText,
    ranges: ranges.map((range) => {
      const start = mapOffset(range.start);
      return { start, length: mapOffset(range.start + range.length) - start, styles: range.styles };
    }),
  };
}
