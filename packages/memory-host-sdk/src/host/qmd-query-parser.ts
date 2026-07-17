// Memory Host SDK module implements qmd query parser behavior.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "./error-utils.js";

// Parser for qmd query JSON output, including noisy CLI wrapper output.

/** Normalized qmd query result consumed by memory search. */
export type QmdQueryResult = {
  docid?: string;
  score?: number;
  collection?: string;
  file?: string;
  snippet?: string;
  body?: string;
  startLine?: number;
  endLine?: number;
};

/** Parse qmd stdout/stderr into normalized results, accepting known no-result markers. */
export function parseQmdQueryJson(stdout: string, stderr: string): QmdQueryResult[] {
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();
  const stdoutIsMarker = trimmedStdout.length > 0 && isQmdNoResultsOutput(trimmedStdout);
  const stderrIsMarker = trimmedStderr.length > 0 && isQmdNoResultsOutput(trimmedStderr);
  if (stdoutIsMarker || (!trimmedStdout && stderrIsMarker)) {
    return [];
  }
  if (!trimmedStdout) {
    const context = trimmedStderr ? ` (stderr: ${summarizeQmdStderr(trimmedStderr)})` : "";
    const message = `stdout empty${context}`;
    warnQmdQueryParseError(message);
    throw new Error(`qmd query returned invalid JSON: ${message}`);
  }
  try {
    const parsed = parseQmdQueryResultPayload(trimmedStdout);
    if (parsed !== null) {
      return parsed;
    }
    for (const noisyPayload of extractJsonPayloadCandidates(trimmedStdout)) {
      const fallback = parseQmdQueryResultPayload(noisyPayload);
      if (fallback !== null) {
        return fallback;
      }
    }
    throw new Error("qmd query JSON response was not an array or results object");
  } catch (err) {
    const message = formatErrorMessage(err);
    warnQmdQueryParseError(message);
    throw new Error(`qmd query returned invalid JSON: ${message}`, { cause: err });
  }
}

/** Emit parse warnings outside tests so broken qmd output is visible to operators. */
function warnQmdQueryParseError(message: string): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  process.stderr.write(`qmd query returned invalid JSON: ${message}\n`);
}

/** Detect qmd no-result marker output on stdout or stderr. */
function isQmdNoResultsOutput(raw: string): boolean {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => normalizeLowercaseStringOrEmpty(line).replace(/\s+/g, " "))
    .filter((line) => line.length > 0);
  return lines.some((line) => isQmdNoResultsLine(line));
}

/** Match qmd no-result lines with optional warning/info prefixes. */
function isQmdNoResultsLine(line: string): boolean {
  if (line === "no results found" || line === "no results found.") {
    return true;
  }
  return /^(?:\[[^\]]+\]\s*)?(?:(?:warn(?:ing)?|info|error|qmd)\s*:\s*)+no results found\.?$/.test(
    line,
  );
}

/** Bound stderr context included in parse errors. */
function summarizeQmdStderr(raw: string): string {
  return raw.length <= 120 ? raw : `${truncateUtf16Safe(raw, 117)}...`;
}

/** Parse and normalize a strict qmd JSON result payload. */
function parseQmdQueryResultPayload(raw: string): QmdQueryResult[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const results = resolveQmdQueryResultItems(parsed);
    if (results === null) {
      return null;
    }
    return results.map(normalizeQmdQueryResult);
  } catch {
    return null;
  }
}

/** Accept legacy array output and qmd query object output. */
function resolveQmdQueryResultItems(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  return Array.isArray(record.results) ? record.results : null;
}

/** Normalize one qmd result row. */
function normalizeQmdQueryResult(item: unknown): QmdQueryResult {
  if (typeof item !== "object" || item === null) {
    return item as QmdQueryResult;
  }
  const record = item as Record<string, unknown>;
  const docid = typeof record.docid === "string" ? record.docid : undefined;
  const score =
    typeof record.score === "number" && Number.isFinite(record.score) ? record.score : undefined;
  const collection = typeof record.collection === "string" ? record.collection : undefined;
  const file = typeof record.file === "string" ? record.file : undefined;
  const snippet = typeof record.snippet === "string" ? record.snippet : undefined;
  const body = typeof record.body === "string" ? record.body : undefined;
  return {
    docid,
    score,
    collection,
    file,
    snippet,
    body,
    startLine: parseQmdLineNumber(record.start_line ?? record.startLine),
    endLine: parseQmdLineNumber(record.end_line ?? record.endLine),
  };
}

/** Normalize qmd line numbers, rejecting zero, negative, and non-integer values. */
function parseQmdLineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Extract complete JSON arrays/objects from noisy stdout. */
function extractJsonPayloadCandidates(raw: string): string[] {
  const candidates: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char !== "[" && char !== "{") {
      continue;
    }
    const end = findJsonPayloadEnd(raw, i);
    if (end === null) {
      continue;
    }
    candidates.push(raw.slice(i, end + 1));
    i = end;
  }
  return candidates;
}

/** Find the end offset for a JSON array or object starting at `start`. */
function findJsonPayloadEnd(raw: string, start: number): number | null {
  const stack: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) {
      break;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "[") {
      stack.push("]");
      depth += 1;
    } else if (char === "{") {
      stack.push("}");
      depth += 1;
    } else if (char === "]") {
      if (stack.pop() !== "]") {
        return null;
      }
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    } else if (char === "}") {
      if (stack.pop() !== "}") {
        return null;
      }
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return null;
}
