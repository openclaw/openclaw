import { normalizeSnippet as normalizeWhitespace } from "./short-term-promotion-utils.js";

const REM_TIME_PREFIX_RE = /^\d{1,2}:\d{2}\s*-\s*/;
const REM_CODE_FENCE_RE = /^\s*```/;
const REM_TABLE_RE = /^\s*\|.*\|\s*$/;
const REM_TABLE_DIVIDER_RE = /^\s*\|?[\s:-]+\|[\s|:-]*$/;

type ParsedSectionLine = {
  line: number;
  text: string;
};

export type ParsedMarkdownSection = {
  title: string;
  startLine: number;
  endLine: number;
  lines: ParsedSectionLine[];
};

export type SectionSnippet = {
  text: string;
  line: number;
};

export type GroundedRemSource = {
  text: string;
  title: string;
};

function stripMarkdown(text: string): string {
  return normalizeWhitespace(
    text
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/[`*_~>#]/g, "")
      .replace(/\s+/g, " "),
  );
}

export function sanitizeSectionTitle(title: string): string {
  return normalizeWhitespace(stripMarkdown(title).replace(REM_TIME_PREFIX_RE, ""));
}

export function makeRef(pathValue: string, startLine: number, endLine = startLine): string {
  return startLine === endLine
    ? `${pathValue}:${startLine}`
    : `${pathValue}:${startLine}-${endLine}`;
}

export function parseMarkdownSections(content: string): ParsedMarkdownSection[] {
  const sections: ParsedMarkdownSection[] = [];
  const lines = content.split(/\r?\n/);
  let current: ParsedMarkdownSection | null = null;
  let inCodeFence = false;

  const flush = () => {
    if (!current) {
      return;
    }
    const meaningfulLines = current.lines.filter(
      (entry) => normalizeWhitespace(entry.text).length > 0,
    );
    if (meaningfulLines.length > 0) {
      const endLine = meaningfulLines[meaningfulLines.length - 1]?.line ?? current.endLine;
      sections.push({ ...current, endLine, lines: meaningfulLines });
    }
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const lineNumber = index + 1;
    if (REM_CODE_FENCE_RE.test(rawLine)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      continue;
    }
    const headingMatch = rawLine.match(/^\s{0,3}(#{2,6})\s+(.+)$/);
    if (headingMatch?.[2]) {
      flush();
      current = {
        title: sanitizeSectionTitle(headingMatch[2]),
        startLine: lineNumber,
        endLine: lineNumber,
        lines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    current.endLine = lineNumber;
    const trimmed = rawLine.trim();
    if (
      !trimmed ||
      /^---+$/.test(trimmed) ||
      REM_TABLE_RE.test(trimmed) ||
      REM_TABLE_DIVIDER_RE.test(trimmed)
    ) {
      continue;
    }
    current.lines.push({ line: lineNumber, text: rawLine });
  }

  flush();
  return sections;
}

export function sectionToSnippets(section: ParsedMarkdownSection): SectionSnippet[] {
  const snippets: SectionSnippet[] = [];
  const seen = new Set<string>();
  for (const entry of section.lines) {
    const trimmed = entry.text.trim();
    if (!trimmed) {
      continue;
    }
    const bulletMatch = trimmed.match(/^(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s*)?(.*)$/);
    const candidateText = bulletMatch?.[1] ?? trimmed;
    const text = stripMarkdown(candidateText);
    if (text.length < 10) {
      continue;
    }
    const dedupeKey = text.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    snippets.push({ text, line: entry.line });
  }
  return snippets;
}

export function collectGroundedRemSourcesByRef(
  relPath: string,
  content: string,
): Map<string, GroundedRemSource> {
  return new Map(
    parseMarkdownSections(content).flatMap((section) =>
      sectionToSnippets(section).map((snippet) => [
        makeRef(relPath, snippet.line),
        { text: snippet.text, title: section.title },
      ]),
    ),
  );
}
