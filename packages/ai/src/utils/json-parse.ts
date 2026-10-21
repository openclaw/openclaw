// JSON parse helpers recover structured values from partial model output.
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as partialParse } from "partial-json";

const SIMPLE_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const JSON_CONTROL_ESCAPES = new Set(["b", "f", "n", "r", "t"]);

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 *
 * By default a valid control escape (`\n`, `\t`, ...) that follows a Windows-path-looking
 * prefix is treated as an unescaped path separator and doubled. Pass
 * `preserveValidControlEscapes` when the text is authoritative (for example a completed
 * tool-call argument buffer) and every valid escape must survive as written.
 */
export function repairJson(
  json: string,
  options?: { preserveValidControlEscapes?: boolean },
): string {
  // oxlint-disable-next-line no-control-regex -- JSON string repair must detect raw control characters.
  if (!/[\\\x00-\x1f]/.test(json)) {
    return json;
  }
  const preserveValidControlEscapes = options?.preserveValidControlEscapes === true;
  let repaired = "";
  let inString = false;
  let stringValuePrefix = "";

  for (let index = 0; index < json.length; index++) {
    const char = json.charAt(index);

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        stringValuePrefix = "";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      stringValuePrefix = "";
      continue;
    }

    if (char === "\\") {
      const nextChar = json.charAt(index + 1);
      if (!nextChar) {
        repaired += "\\\\";
        continue;
      }

      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          stringValuePrefix += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }

      if (!preserveValidControlEscapes && JSON_CONTROL_ESCAPES.has(nextChar)) {
        // Only this suffix can influence the Windows-path heuristic.
        stringValuePrefix = stringValuePrefix.slice(-160);
        if (looksLikeWindowsPathPrefix(stringValuePrefix)) {
          repaired += "\\\\";
          stringValuePrefix += "\\";
          continue;
        }
      }

      if (SIMPLE_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        stringValuePrefix += nextChar === "\\" ? "\\" : `\\${nextChar}`;
        index += 1;
        continue;
      }

      repaired += "\\\\";
      stringValuePrefix += "\\";
      continue;
    }

    repaired += char.charCodeAt(0) <= 0x1f ? JSON.stringify(char).slice(1, -1) : char;
    stringValuePrefix += char;
  }

  return repaired;
}

export function parseJsonWithRepair(json: string): unknown {
  return JSON.parse(repairJson(json)) as unknown;
}

function looksLikeWindowsPathPrefix(prefix: string): boolean {
  return /(?:^|[^A-Za-z0-9])[A-Za-z]:(?:[\\/][^"\\/:*?<>|\r\n]*)*$/.test(prefix);
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
  if (!partialJson || partialJson.trim() === "") {
    return {};
  }

  try {
    return asNonArrayRecord(parseJsonWithRepair(partialJson));
  } catch {
    try {
      return asNonArrayRecord(partialParse(partialJson));
    } catch {
      return {};
    }
  }
}

const TOOL_ARGUMENT_PREVIEW_FIRST_CHECKPOINT_CHARS = 512;

/** Returns true when the streamed argument buffer crossed its next preview checkpoint. */
export type ToolArgumentPreviewSchedule = (accumulatedChars: number) => boolean;

/**
 * Streamed tool-call arguments are preview-only; the terminal parse re-reads
 * the full buffer authoritatively at content_block_stop. Reparsing every delta
 * scans an ever-growing buffer and makes assembly quadratic in the argument
 * size, so refresh previews on a geometric length schedule instead — bounded
 * staleness, linear total parse work.
 */
export function createToolArgumentPreviewSchedule(): ToolArgumentPreviewSchedule {
  let nextCheckpointChars = TOOL_ARGUMENT_PREVIEW_FIRST_CHECKPOINT_CHARS;
  return (accumulatedChars: number): boolean => {
    if (accumulatedChars < nextCheckpointChars) {
      return false;
    }
    nextCheckpointChars = accumulatedChars * 2;
    return true;
  };
}
