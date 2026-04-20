import { extractDailyMemoryDayFromPath } from "./daily-paths.js";

export type DreamDiaryBackfillEntry = {
  isoDay: string;
  sourcePath?: string;
  bodyLines: string[];
};

const MERGED_DIARY_LIST_LINE_RE = /^(?:\d+\.\s+|[-*+]\s+)/;

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter((line, index, lines) => !(line.length === 0 && lines[index - 1]?.length === 0));
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
        bodyLines: [...bodyLines],
        seenLines: new Set(bodyLines.filter((line) => shouldDedupeMergedDiaryLine(line))),
      });
      continue;
    }
    if (existing.sourcePath && existing.sourcePath !== sourcePath) {
      existing.sourcePath = undefined;
    }
    if (
      existing.bodyLines.length > 0 &&
      existing.bodyLines[existing.bodyLines.length - 1] !== "" &&
      bodyLines[0] !== ""
    ) {
      existing.bodyLines.push("");
    }
    for (const line of bodyLines) {
      if (line === "") {
        if (existing.bodyLines[existing.bodyLines.length - 1] !== "") {
          existing.bodyLines.push(line);
        }
        continue;
      }
      if (shouldDedupeMergedDiaryLine(line) && existing.seenLines.has(line)) {
        continue;
      }
      if (shouldDedupeMergedDiaryLine(line)) {
        existing.seenLines.add(line);
      }
      existing.bodyLines.push(line);
    }
  }
  return [...entries.values()].map(({ seenLines: _seenLines, ...entry }) => entry);
}
