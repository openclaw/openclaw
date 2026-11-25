export const USER_SOURCE_FILE = "openclaw-code-mode:user.js";
export const SOURCE_LOCATION_KEY = "__openclawSourceLocation";

export type SourceLocation = {
  file: typeof USER_SOURCE_FILE;
  lineOffset: number;
  lineCount: number;
  columnOffset: number;
  endColumn: number;
};

function sourceExtent(
  source: string,
  columnUnits: "utf8" | "utf16",
): { lines: number; lastColumn: number } {
  let lines = 1;
  let lastLineStart = 0;
  for (const match of source.matchAll(/\r\n|[\r\n\u2028\u2029]/gu)) {
    lines += 1;
    lastLineStart = match.index + match[0].length;
  }
  const lastLine = source.slice(lastLineStart);
  return {
    lines,
    lastColumn:
      (columnUnits === "utf8" ? Buffer.byteLength(lastLine, "utf8") : lastLine.length) + 1,
  };
}

export function normalizeSourceStack(
  stack: string | undefined,
  location?: SourceLocation,
): string | undefined {
  if (!stack || !location) {
    return stack;
  }
  // Leave arbitrary guest stack text opaque instead of copying every line into an array.
  return stack.replace(
    /^[^\S\r\n]+at [^\r\n]*openclaw-code-mode:(?:user|controller)\.js:\d+:\d+\)?(?:\r?\n|$)/gmu,
    (frame) => {
      const match = /openclaw-code-mode:user\.js:(\d+):(\d+)(?=\)?(?:\r?\n)?$)/u.exec(frame);
      if (!match) {
        return "";
      }
      const line = Number(match[1]) - location.lineOffset;
      const originalColumn = Number(match[2]);
      const column = originalColumn - (line === 1 ? location.columnOffset : 0);
      if (
        line < 1 ||
        line > location.lineCount ||
        column < 1 ||
        (line === location.lineCount && originalColumn > location.endColumn)
      ) {
        return "";
      }
      return frame.replace(match[0], location.file + ":" + line + ":" + column);
    },
  );
}

export function buildUserSource(
  code: string,
  prelude = "",
  columnUnits: "utf8" | "utf16" = "utf8",
): { source: string; location: SourceLocation } {
  const prefix = `globalThis.__openclawResult = __openclawRunCell(async () => {\n${prelude}`;
  const before = sourceExtent(prefix, columnUnits);
  const body = sourceExtent(code, columnUnits);
  const columnOffset = before.lastColumn - 1;
  return {
    source: `${prefix}${code}\n})`,
    location: {
      file: USER_SOURCE_FILE,
      lineOffset: before.lines - 1,
      lineCount: body.lines,
      columnOffset,
      endColumn: body.lastColumn + (body.lines === 1 ? columnOffset : 0),
    },
  };
}
