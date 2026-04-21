import { extractDailyMemoryDayFromPath } from "./daily-paths.js";

export type DreamDiaryBackfillEntry = {
  isoDay: string;
  sourcePath?: string;
  bodyLines: string[];
};

type MergedDiaryLine = {
  text: string;
  dedupeScope?: string;
};

const MERGED_DIARY_LIST_LINE_RE = /^(?:\d+\.\s+|[-*+]\s+)/;

function groundedMarkdownToDiaryLines(markdown: string): MergedDiaryLine[] {
  const rawLines = markdown.split(/\r?\n/);
  const lines: MergedDiaryLine[] = [];
  let currentSection = "";
  for (const rawLine of rawLines) {
    const isSectionHeading = /^##\s+/.test(rawLine);
    const text = rawLine.replace(/^##\s+/, "").trimEnd();
    if (text.length === 0) {
      if (lines[lines.length - 1]?.text !== "") {
        lines.push({ text });
      }
      continue;
    }
    if (isSectionHeading) {
      currentSection = text.trim().toLowerCase();
      lines.push({ text });
      continue;
    }
    lines.push({
      text,
      dedupeScope: shouldDedupeMergedDiaryLine(text) ? currentSection : undefined,
    });
  }
  return lines;
}

function shouldDedupeMergedDiaryLine(line: string): boolean {
  return MERGED_DIARY_LIST_LINE_RE.test(line.trim());
}

export function collectDreamDiaryBackfillEntries(params: {
  files: Array<{ path: string; renderedMarkdown: string }>;
  resolveSourcePath?: (filePath: string, isoDay: string) => string;
}): DreamDiaryBackfillEntry[] {
  const entries = new Map<
    string,
    DreamDiaryBackfillEntry & {
      seenLines: Set<string>;
    }
  >();
  for (const file of params.files) {
    const isoDay = extractDailyMemoryDayFromPath(file.path);
    if (!isoDay) {
      continue;
    }
    const bodyLines = groundedMarkdownToDiaryLines(file.renderedMarkdown);
    if (bodyLines.length === 0) {
      continue;
    }
    const sourcePath = params.resolveSourcePath?.(file.path, isoDay) ?? file.path;
    const existing = entries.get(isoDay);
    if (!existing) {
      entries.set(isoDay, {
        isoDay,
        sourcePath,
        bodyLines: bodyLines.map((line) => line.text),
        seenLines: new Set(
          bodyLines
            .filter((line) => shouldDedupeMergedDiaryLine(line.text))
            .map((line) => `${line.dedupeScope ?? ""}\u0000${line.text}`),
        ),
      });
      continue;
    }
    if (existing.sourcePath && existing.sourcePath !== sourcePath) {
      existing.sourcePath = undefined;
    }
    if (
      existing.bodyLines.length > 0 &&
      existing.bodyLines[existing.bodyLines.length - 1] !== "" &&
      bodyLines[0]?.text !== ""
    ) {
      existing.bodyLines.push("");
    }
    for (const line of bodyLines) {
      if (line.text === "") {
        if (existing.bodyLines[existing.bodyLines.length - 1] !== "") {
          existing.bodyLines.push(line.text);
        }
        continue;
      }
      const dedupeKey = `${line.dedupeScope ?? ""}\u0000${line.text}`;
      if (shouldDedupeMergedDiaryLine(line.text) && existing.seenLines.has(dedupeKey)) {
        continue;
      }
      if (shouldDedupeMergedDiaryLine(line.text)) {
        existing.seenLines.add(dedupeKey);
      }
      existing.bodyLines.push(line.text);
    }
  }
  return [...entries.values()].map(({ seenLines: _seenLines, ...entry }) => entry);
}
