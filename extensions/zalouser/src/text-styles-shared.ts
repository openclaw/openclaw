import type { markdownToIRWithMeta } from "openclaw/plugin-sdk/text-chunking";
import { TextStyle, type Style } from "./zca-constants.js";

export type MarkdownIRWithMetadata = ReturnType<typeof markdownToIRWithMeta>["ir"];

export type InlineStyle = (typeof TextStyle)[keyof typeof TextStyle];

export type StructuralStyle = {
  start: number;
  end: number;
  style: InlineStyle;
  indentSize?: number;
  priority: number;
};

export type TextEdit = {
  start: number;
  end: number;
  text: string;
  indentSize?: number;
  listStyle?: InlineStyle;
};

export const TAG_STYLE_MAP: Record<string, InlineStyle | null> = {
  red: TextStyle.Red,
  orange: TextStyle.Orange,
  yellow: TextStyle.Yellow,
  green: TextStyle.Green,
  small: null,
  big: TextStyle.Big,
  underline: TextStyle.Underline,
};

export type LocalToken =
  | { kind: "literal"; text: string }
  | { kind: "tag-open"; id: number; style: InlineStyle | null }
  | { kind: "tag-close"; id: number };

export type TokenRegistry = {
  nextId: number;
  prefix: string;
  tokens: Map<string, LocalToken>;
};

export type OrderedStyle = Style & { rawStart: number; rawEnd: number };

export const ZALOUSER_STYLE_MAP = {
  bold: TextStyle.Bold,
  italic: TextStyle.Italic,
  underline: TextStyle.Underline,
  strikethrough: TextStyle.StrikeThrough,
  heading_1: TextStyle.Bold,
  heading_2: TextStyle.Bold,
  heading_3: TextStyle.Bold,
  heading_4: TextStyle.Bold,
} as const;

export const LOCAL_TAG_PATTERN = new RegExp(
  `\\{(${Object.keys(TAG_STYLE_MAP).join("|")})\\}(.+?)\\{/\\1\\}`,
  "g",
);

export const UNICODE_SEPARATOR_PATTERN =
  /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u;

/**
 * Matches a line carrying only blockquote markers and trailing whitespace.
 *
 * The run between two `>` markers is spelled once -- a tab plus up to 3 spaces,
 * or up to 4 spaces -- instead of ending each repetition with `[ \t]?` while
 * the next begins with ` {0,3}`. That overlap let either side claim a space, so
 * a line that failed to match admitted many equivalent splits and matching
 * degraded superlinearly. Spelling the run once forces one split per marker.
 */
export const BLOCKQUOTE_ONLY_LINE_PATTERN = /^ {0,3}>(?:(?:\t {0,3}| {0,4})>)*[ \t]*$/u;

export function projectOffset(offsets: number[], offset: number): number {
  return offsets[Math.max(0, Math.min(offset, offsets.length - 1))] ?? offsets.at(-1) ?? 0;
}

export function normalizeCodeBlockLeadingWhitespace(line: string): string {
  return line.replace(/^[ \t]+/, (leadingWhitespace) =>
    leadingWhitespace.replace(/\t/g, "\u00A0\u00A0\u00A0\u00A0").replace(/ /g, "\u00A0"),
  );
}
