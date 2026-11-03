/**
 * Parser for OpenAI-style apply_patch envelopes: add, delete, and update hunks
 * with optional moves and context-anchored update chunks.
 */
import type { UpdateFileChunk } from "./apply-patch-update.js";
import { ToolInputError } from "./tool-input-error.js";

const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";

type AddFileHunk = {
  kind: "add";
  path: string;
  contents: string;
};

type DeleteFileHunk = {
  kind: "delete";
  path: string;
};

type UpdateFileHunk = {
  kind: "update";
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
};

export type Hunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

export function parsePatchText(input: string): Hunk[] {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new ToolInputError("Invalid patch: input is empty.");
  }

  const lines = checkPatchBoundaries(trimmed.split(/\r?\n/)).slice(1, -1);
  const hunks: Hunk[] = [];
  for (let offset = 0; offset < lines.length;) {
    const { hunk, consumed } = parseOneHunk(lines.slice(offset), offset + 2);
    hunks.push(hunk);
    offset += consumed;
  }

  return hunks;
}

function checkPatchBoundaries(inputLines: string[]): string[] {
  const first = inputLines[0];
  const last = inputLines.at(-1);
  const lines =
    inputLines.length >= 4 &&
    last &&
    (first === "<<EOF" || first === "<<'EOF'" || first === '<<"EOF"') &&
    last.endsWith("EOF")
      ? inputLines.slice(1, -1)
      : inputLines;
  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) {
    throw new ToolInputError("The first line of the patch must be '*** Begin Patch'");
  }
  if (lines.at(-1)?.trim() !== END_PATCH_MARKER) {
    throw new ToolInputError("The last line of the patch must be '*** End Patch'");
  }
  return lines;
}

function parseOneHunk(lines: string[], lineNumber: number): { hunk: Hunk; consumed: number } {
  const firstLine = lines[0]!.trim();
  if (firstLine.startsWith(ADD_FILE_MARKER)) {
    const targetPath = firstLine.slice(ADD_FILE_MARKER.length);
    let contents = "";
    let consumed = 1;
    for (const addLine of lines.slice(1)) {
      if (addLine.startsWith("+")) {
        contents += `${addLine.slice(1)}\n`;
        consumed += 1;
      } else {
        break;
      }
    }
    return {
      hunk: { kind: "add", path: targetPath, contents },
      consumed,
    };
  }

  if (firstLine.startsWith(DELETE_FILE_MARKER)) {
    const targetPath = firstLine.slice(DELETE_FILE_MARKER.length);
    return {
      hunk: { kind: "delete", path: targetPath },
      consumed: 1,
    };
  }

  if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
    const targetPath = firstLine.slice(UPDATE_FILE_MARKER.length);
    let consumed = 1;
    let movePath: string | undefined;

    const moveCandidate = lines[consumed]?.trim();
    if (moveCandidate?.startsWith(MOVE_TO_MARKER)) {
      movePath = moveCandidate.slice(MOVE_TO_MARKER.length);
      consumed += 1;
    }

    const chunks: UpdateFileChunk[] = [];
    while (consumed < lines.length) {
      const firstRemaining = lines[consumed]!;
      if (firstRemaining.trim() === "") {
        consumed += 1;
        continue;
      }
      if (firstRemaining.startsWith("***")) {
        break;
      }
      const { chunk, consumed: chunkLines } = parseUpdateFileChunk(
        lines.slice(consumed),
        lineNumber + consumed,
        chunks.length === 0,
      );
      chunks.push(chunk);
      consumed += chunkLines;
    }

    if (chunks.length === 0) {
      throw new ToolInputError(
        `Invalid patch hunk at line ${lineNumber}: Update file hunk for path '${targetPath}' is empty`,
      );
    }

    return {
      hunk: {
        kind: "update",
        path: targetPath,
        movePath,
        chunks,
      },
      consumed,
    };
  }

  throw new ToolInputError(
    `Invalid patch hunk at line ${lineNumber}: '${lines[0]}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
  );
}

function parseUpdateFileChunk(
  lines: string[],
  lineNumber: number,
  allowMissingContext: boolean,
): { chunk: UpdateFileChunk; consumed: number } {
  let changeContext: string | undefined;
  let startIndex = 0;
  const firstLine = lines.at(0);
  if (firstLine === EMPTY_CHANGE_CONTEXT_MARKER) {
    startIndex = 1;
  } else if (firstLine?.startsWith(CHANGE_CONTEXT_MARKER)) {
    changeContext = firstLine.slice(CHANGE_CONTEXT_MARKER.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new ToolInputError(
      `Invalid patch hunk at line ${lineNumber}: Expected update hunk to start with a @@ context marker, got: '${firstLine}'`,
    );
  }

  if (startIndex >= lines.length || lines[startIndex] === EOF_MARKER) {
    throw new ToolInputError(
      `Invalid patch hunk at line ${lineNumber + 1}: Update hunk does not contain any lines`,
    );
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    contextOldIndexes: [],
    isEndOfFile: false,
  };

  let parsedLines = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      chunk.isEndOfFile = true;
      parsedLines += 1;
      break;
    }

    const marker = line[0];
    if (!marker || marker === " " || marker === "+" || marker === "-") {
      const content = line.slice(1);
      if (marker !== "-") {
        chunk.contextOldIndexes.push(marker === "+" ? undefined : chunk.oldLines.length);
        chunk.newLines.push(content);
      }
      if (marker !== "+") {
        chunk.oldLines.push(content);
      }
      parsedLines += 1;
      continue;
    }

    if (parsedLines === 0) {
      throw new ToolInputError(
        `Invalid patch hunk at line ${lineNumber + 1}: Unexpected line found in update hunk: '${line}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
      );
    }
    break;
  }

  return { chunk, consumed: parsedLines + startIndex };
}
