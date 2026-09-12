// Matrix helper module resolves spoiler delimiters in ordinary Markdown inline blocks.
import MarkdownIt, { type Env } from "markdown-it";
import { findCodeRegions, isInsideCode, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { isMarkdownEscaped, projectMatrixMarkdown } from "./format-profile.js";
import { findMatrixTableSourceRanges } from "./format-table-ranges.js";

const spoilerParser = new MarkdownIt({ html: false, linkify: true, typographer: false });
spoilerParser.linkify.set({ fuzzyLink: true });

function findInlineMetadataRanges(
  markdown: string,
  references: ReadonlySet<string>,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const labelStack: number[] = [];
  const codeRegions = findCodeRegions(markdown);
  const underlineTags = [...tokenizeHtmlTags(markdown)].filter(
    (tag) => tag.name === "u" || tag.name === "ins",
  );
  for (let index = 0; index < markdown.length - 1; index += 1) {
    const underlineTag = underlineTags.find((tag) => tag.start === index);
    if (underlineTag) {
      index = underlineTag.end - 1;
      continue;
    }
    if (isInsideCode(index, codeRegions)) {
      continue;
    }
    if (markdown[index] === "\n" && markdown[index + 1] === "\n") {
      labelStack.length = 0;
      continue;
    }
    if (markdown[index] === "[" && !isMarkdownEscaped(markdown, index)) {
      labelStack.push(index);
      continue;
    }
    if (
      markdown[index] === "]" &&
      markdown[index + 1] === "(" &&
      !isMarkdownEscaped(markdown, index) &&
      labelStack.pop() !== undefined
    ) {
      const start = index + 2;
      let cursor = start;
      while (/[\s]/u.test(markdown[cursor] ?? "")) {
        cursor += 1;
      }
      const destination = spoilerParser.helpers.parseLinkDestination(
        markdown,
        cursor,
        markdown.length,
      );
      if (destination.ok) {
        cursor = destination.pos;
        while (/[\s]/u.test(markdown[cursor] ?? "")) {
          cursor += 1;
        }
        const title = spoilerParser.helpers.parseLinkTitle(markdown, cursor, markdown.length);
        if (title.ok) {
          cursor = title.pos;
          while (/[\s]/u.test(markdown[cursor] ?? "")) {
            cursor += 1;
          }
        }
      }
      if (destination.ok && markdown[cursor] === ")") {
        ranges.push({ start, end: cursor + 1 });
        index = cursor;
      }
      continue;
    }
    if (
      markdown[index] === "]" &&
      markdown[index + 1] === "[" &&
      !isMarkdownEscaped(markdown, index) &&
      labelStack.pop() !== undefined
    ) {
      let end = index + 2;
      while (end < markdown.length && (markdown[end] !== "]" || isMarkdownEscaped(markdown, end))) {
        end += 1;
      }
      const reference = spoilerParser.utils.normalizeReference(markdown.slice(index + 2, end));
      if (end < markdown.length && references.has(reference)) {
        ranges.push({ start: index + 2, end });
        index = end;
      }
      continue;
    }
    if (markdown[index] === "]" && !isMarkdownEscaped(markdown, index)) {
      labelStack.pop();
    }
    const autolink = /^<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*>/u.exec(markdown.slice(index));
    if (autolink && !isMarkdownEscaped(markdown, index)) {
      ranges.push({ start: index, end: index + autolink[0].length });
      index += autolink[0].length - 1;
      continue;
    }
    const emailAutolink = /^<[^<>\s@]+@[^<>\s@]+>/u.exec(markdown.slice(index));
    if (emailAutolink && !isMarkdownEscaped(markdown, index)) {
      ranges.push({ start: index, end: index + emailAutolink[0].length });
      index += emailAutolink[0].length - 1;
    }
  }
  return ranges;
}

export function prepareMatrixMarkdownSource(markdown: string) {
  const env: Env = {};
  const tokens = spoilerParser.parse(markdown, env);
  const references = new Set(Object.keys(env.references ?? {}));
  const lineStarts = [0];
  for (let index = 0; index < markdown.length; index += 1) {
    if (markdown[index] === "\n") {
      lineStarts.push(index + 1);
    }
  }
  lineStarts.push(markdown.length);
  const inlineRanges = tokens.flatMap((token) => {
    // Table-cell inline tokens have no source map because pipes belong to GFM table grammar.
    if (token.type !== "inline" || !token.map) {
      return [];
    }
    const start = lineStarts[token.map[0]] ?? 0;
    const end = lineStarts[token.map[1]] ?? markdown.length;
    return [{ start, end }];
  });
  const ranges = inlineRanges.flatMap(({ start, end }) =>
    findInlineMetadataRanges(markdown.slice(start, end), references).map((range) => ({
      start: start + range.start,
      end: start + range.end,
    })),
  );
  for (const match of markdown.matchAll(/^\s*\[[^\]\n]+\]:\s*.+$/gmu)) {
    const start = match.index ?? 0;
    const labelEnd = match[0].indexOf("]:");
    const reference = spoilerParser.utils.normalizeReference(match[0].slice(1, labelEnd));
    if (references.has(reference)) {
      let end = start + match[0].length;
      const continuation = /^\n[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))[ \t]*/u.exec(
        markdown.slice(end),
      );
      end += continuation?.[0].length ?? 0;
      ranges.push({ start, end });
    }
  }
  const codeRegions = findCodeRegions(markdown);
  for (const match of spoilerParser.linkify.match(markdown) ?? []) {
    if (!isInsideCode(match.index, codeRegions)) {
      ranges.push({ start: match.index, end: match.lastIndex });
    }
  }
  return {
    markdown,
    inlineRanges,
    metadataRanges: ranges,
    codeRegions,
    underlineTags: [...tokenizeHtmlTags(markdown)].filter(
      (tag) => tag.name === "u" || tag.name === "ins",
    ),
  };
}

type MatrixMarkdownSource = ReturnType<typeof prepareMatrixMarkdownSource>;

function findMatrixSpoilerDelimiterOffsets(source: MatrixMarkdownSource): number[] {
  const { markdown, inlineRanges, codeRegions, metadataRanges, underlineTags } = source;
  const excludedRanges = [...codeRegions, ...metadataRanges, ...underlineTags];
  const offsets: number[] = [];
  for (const { start, end } of inlineRanges) {
    const candidates: number[] = [];
    for (let index = start; index < end - 1; index += 1) {
      if (markdown[index] !== "|" || markdown[index + 1] !== "|") {
        continue;
      }
      const excluded = excludedRanges.some((range) => index >= range.start && index < range.end);
      if (isMarkdownEscaped(markdown, index) || excluded) {
        continue;
      }
      candidates.push(index);
      index += 1;
    }
    candidates.length -= candidates.length % 2;
    offsets.push(...candidates);
  }
  return [...new Set(offsets)].toSorted((left, right) => left - right);
}

function hasMatrixSpoilerMetadataCollision(
  source: MatrixMarkdownSource,
  offsets: number[],
): boolean {
  const { markdown, codeRegions } = source;
  const ordinary = new Set(offsets);
  const underlineTags = source.underlineTags.filter(
    (tag) => !isMarkdownEscaped(markdown, tag.start),
  );
  // Matrix consumes underline tags before parsing inline code, so backticks
  // inside their attributes cannot make a literal code region.
  const literalRanges = [
    ...findMatrixTableSourceRanges(markdown),
    ...codeRegions.filter(
      (code) => !underlineTags.some((tag) => code.start > tag.start && code.start < tag.end),
    ),
  ];
  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (markdown[index] !== "|" || markdown[index + 1] !== "|") {
      continue;
    }
    if (ordinary.has(index) || isMarkdownEscaped(markdown, index)) {
      continue;
    }
    if (literalRanges.some((range) => index >= range.start && index < range.end)) {
      continue;
    }
    return true;
  }
  return false;
}

export type MatrixSpoilerAnalysis = {
  markdown: string;
  delimiterOffsets: number[];
  metadataCollision: boolean;
};

export function analyzeMatrixSpoilers(markdown: string): MatrixSpoilerAnalysis {
  const projected = projectMatrixMarkdown(markdown);
  if (!projected.includes("||")) {
    return { markdown: projected, delimiterOffsets: [], metadataCollision: false };
  }
  const source = prepareMatrixMarkdownSource(projected);
  const delimiterOffsets = findMatrixSpoilerDelimiterOffsets(source);
  return {
    markdown: projected,
    delimiterOffsets,
    metadataCollision: hasMatrixSpoilerMetadataCollision(source, delimiterOffsets),
  };
}
