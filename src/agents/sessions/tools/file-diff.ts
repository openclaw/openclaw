import { FILE_HEADERS_ONLY, formatPatch, structuredPatch, type StructuredPatchHunk } from "diff";

export type FileDiff = {
  diff: string;
  patch: string;
  firstChangedLine?: number;
};

/** Both receipts describe the same hunks from one diff computation. */
export function prepareFileDiff(
  path: string,
  oldContent: string,
  newContent: string,
  options: { context?: number; maxEditLength?: number } = {},
): FileDiff | undefined {
  const patch = structuredPatch(path, path, oldContent, newContent, undefined, undefined, {
    context: 4,
    ...options,
  });
  if (!patch) {
    return undefined;
  }
  return {
    ...formatDiffString(oldContent, newContent, patch.hunks),
    patch: formatPatch(patch, FILE_HEADERS_ONLY),
  };
}

function formatDiffString(
  oldContent: string,
  newContent: string,
  hunks: StructuredPatchHunk[],
): Pick<FileDiff, "diff" | "firstChangedLine"> {
  const oldLineCount = oldContent.split("\n").length;
  const newLineCount = newContent.split("\n").length;
  const lastNewLine = newContent === "" ? 0 : newLineCount - Number(newContent.endsWith("\n"));
  const maxLineNum = Math.max(oldLineCount, newLineCount);
  const lineNumWidth = String(maxLineNum).length;
  const ellipsis = ` ${"".padStart(lineNumWidth, " ")} ...`;
  const output: string[] = [];
  let firstChangedLine: number | undefined;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    if (hunkIndex > 0 || hunk.newStart > 1) {
      output.push(ellipsis);
    }

    let oldLineNum = hunk.oldStart;
    let newLineNum = hunk.newStart;
    for (const line of hunk.lines) {
      const prefix = line[0];
      if (prefix === "\\") {
        continue;
      }
      if (firstChangedLine === undefined && prefix !== " ") {
        firstChangedLine = newLineNum;
      }
      const lineNum = prefix === "-" ? oldLineNum : newLineNum;
      output.push(`${prefix}${String(lineNum).padStart(lineNumWidth, " ")} ${line.slice(1)}`);
      oldLineNum += prefix === "+" ? 0 : 1;
      newLineNum += prefix === "-" ? 0 : 1;
    }

    if (hunkIndex === hunks.length - 1 && hunk.newStart + hunk.newLines <= lastNewLine) {
      output.push(ellipsis);
    }
  }

  return { diff: output.join("\n"), firstChangedLine };
}

export const WRITE_DIFF_MAX_BYTES = 1024 * 1024;
const WRITE_DIFF_MAX_COMBINED_LINES = 20_000;
const WRITE_DIFF_MAX_EDIT_LENGTH = 2_000;

function countNewlines(text: string): number {
  let count = 0;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
    count += 1;
  }
  return count;
}

export function prepareFileWriteDiff(params: {
  path: string;
  content: string;
  beforeText?: string;
  created?: boolean;
}): FileDiff | undefined {
  const beforeText = params.created ? "" : params.beforeText;
  if (
    beforeText === undefined ||
    beforeText.includes("\uFFFD") ||
    beforeText.includes("\0") ||
    Buffer.byteLength(beforeText, "utf8") + Buffer.byteLength(params.content, "utf8") >
      WRITE_DIFF_MAX_BYTES ||
    countNewlines(beforeText) + countNewlines(params.content) > WRITE_DIFF_MAX_COMBINED_LINES
  ) {
    return undefined;
  }
  return prepareFileDiff(
    params.path,
    beforeText,
    params.content,
    params.created ? {} : { maxEditLength: WRITE_DIFF_MAX_EDIT_LENGTH },
  );
}
