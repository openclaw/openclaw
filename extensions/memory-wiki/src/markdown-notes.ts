import { forEachMarkdownCodeRange } from "./markdown-links.js";

const HUMAN_START_MARKER = "<!-- openclaw:human:start -->";
const HUMAN_END_MARKER = "<!-- openclaw:human:end -->";
const HUMAN_MARKER_PATTERN = new RegExp(`${HUMAN_START_MARKER}|${HUMAN_END_MARKER}`, "g");

export function hasMarkedNotesInsideManagedRange(
  page: string,
  managedRanges: ReadonlyArray<{ start: number; end: number }>,
): boolean {
  const codeRanges: Array<{ start: number; end: number }> = [];
  forEachMarkdownCodeRange(page, (start, end) => codeRanges.push({ start, end }));
  const isCode = (offset: number) =>
    codeRanges.some((range) => offset >= range.start && offset < range.end);
  let managedNotesEnd = 0;
  let managedNotes = false;
  let lineStart = 0;
  while (lineStart < page.length) {
    const newline = page.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? page.length : newline;
    const line = page.slice(lineStart, lineEnd).replace(/\r$/u, "");
    if (!isCode(lineStart) && /^ {0,3}##[\t ]+/u.test(line)) {
      const range = /^## Notes[\t ]*$/u.test(line)
        ? managedRanges.find(
            (candidate) => lineStart >= candidate.start && lineStart < candidate.end,
          )
        : undefined;
      managedNotes = range !== undefined;
      managedNotesEnd = range?.end ?? 0;
    }
    if (managedNotes && lineStart < managedNotesEnd) {
      for (const marker of line.matchAll(HUMAN_MARKER_PATTERN)) {
        if (!isCode(lineStart + (marker.index ?? 0))) {
          return true;
        }
      }
    }
    lineStart = newline === -1 ? page.length : newline + 1;
  }
  return false;
}
