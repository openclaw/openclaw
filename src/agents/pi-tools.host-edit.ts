import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

// ─── Fuzzy Match Suggestion Constants ───

const FUZZY_MAX_FILE_SIZE_BYTES = 100_000;
const FUZZY_MAX_SUGGESTIONS = 3;
const FUZZY_MIN_SIMILARITY = 0.4;
const FUZZY_MAX_LINE_LEN = 500;
const FUZZY_CONTEXT_LINES = 2;
const FUZZY_MAX_OUTPUT_CHARS = 2000;
const FUZZY_BINARY_CHECK_BYTES = 8192;
const FUZZY_PREFILTER_CHUNK_LEN = 8;

type FuzzyMatchReadFile = (absolutePath: string, signal?: AbortSignal) => Promise<Buffer | string>;

type FuzzyMatchStat = {
  size: number;
};

type FuzzyMatchSuggestionOptions = {
  readFile?: FuzzyMatchReadFile;
  stat?: (absolutePath: string, signal?: AbortSignal) => Promise<FuzzyMatchStat | null>;
};

/** Resolve path for host edit: expand ~ and resolve relative paths against root. */
function resolveHostEditPath(root: string, pathParam: string): string {
  const expanded =
    pathParam.startsWith("~/") || pathParam === "~"
      ? pathParam.replace(/^~/, os.homedir())
      : pathParam;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

/**
 * When the upstream edit tool throws after having already written (e.g. generateDiffString fails),
 * the file may be correctly updated but the tool reports failure. This wrapper catches errors and
 * if the target file on disk contains the intended newText, returns success so we don't surface
 * a false "edit failed" to the user (fixes #32333, same pattern as #30773 for write).
 */
export function wrapHostEditToolWithPostWriteRecovery(
  base: AnyAgentTool,
  root: string,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
        const pathParam = record && typeof record.path === "string" ? record.path : undefined;
        const newText =
          record && typeof record.newText === "string"
            ? record.newText
            : record && typeof record.new_string === "string"
              ? record.new_string
              : undefined;
        const oldText =
          record && typeof record.oldText === "string"
            ? record.oldText
            : record && typeof record.old_string === "string"
              ? record.old_string
              : undefined;
        if (!pathParam || !newText) {
          throw err;
        }
        try {
          const absolutePath = resolveHostEditPath(root, pathParam);
          const content = await fs.readFile(absolutePath, "utf-8");
          // Only recover when the replacement likely occurred: newText is present and oldText
          // is no longer present. This avoids false success when upstream threw before writing
          // (e.g. oldText not found) but the file already contained newText (review feedback).
          const hasNew = content.includes(newText);
          const stillHasOld =
            oldText !== undefined && oldText.length > 0 && content.includes(oldText);
          if (hasNew && !stillHasOld) {
            return {
              content: [
                {
                  type: "text",
                  text: `Successfully replaced text in ${pathParam}.`,
                },
              ],
              details: { diff: "", firstChangedLine: undefined },
            } as AgentToolResult<unknown>;
          }
        } catch {
          // File read failed or path invalid; rethrow original error.
        }
        throw err;
      }
    },
  };
}

// ─── Fuzzy Match Suggestion Helpers ───

/** Space-optimized LCS length between two strings, capped at FUZZY_MAX_LINE_LEN chars each. */
export function lcsLength(a: string, b: string): number {
  const m = Math.min(a.length, FUZZY_MAX_LINE_LEN);
  const n = Math.min(b.length, FUZZY_MAX_LINE_LEN);
  if (m === 0 || n === 0) {
    return 0;
  }
  const prev = new Uint16Array(n + 1);
  const curr = new Uint16Array(n + 1);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    prev.set(curr);
    curr.fill(0);
  }
  return prev[n];
}

/** Normalized LCS ratio: 0.0 (no similarity) to 1.0 (identical). */
export function lcsRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) {
    return 1.0;
  }
  if (a.length === 0 || b.length === 0) {
    return 0.0;
  }
  const len = lcsLength(a, b);
  return (
    (2 * len) / (Math.min(a.length, FUZZY_MAX_LINE_LEN) + Math.min(b.length, FUZZY_MAX_LINE_LEN))
  );
}

interface ScoredWindow {
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed, inclusive
  score: number;
  lines: string[];
}

function hasSharedPreFilterChunk(fileLine: string, oldLine: string): boolean {
  // Ignore indentation so leading whitespace-only edits do not block fuzzy suggestions.
  const fileTrimmed = fileLine.trimStart();
  const oldTrimmed = oldLine.trimStart();
  if (
    oldTrimmed.length < FUZZY_PREFILTER_CHUNK_LEN ||
    fileTrimmed.length < FUZZY_PREFILTER_CHUNK_LEN
  ) {
    // Short lines are cheap to score with LCS, so skip the substring gate entirely.
    return true;
  }

  const lastChunkStart = oldTrimmed.length - FUZZY_PREFILTER_CHUNK_LEN;
  const chunkStarts = new Set([0, Math.floor(lastChunkStart / 2), lastChunkStart]);
  for (const chunkStart of chunkStarts) {
    const chunk = oldTrimmed.slice(chunkStart, chunkStart + FUZZY_PREFILTER_CHUNK_LEN);
    if (fileTrimmed.includes(chunk)) {
      return true;
    }
  }

  return false;
}

/**
 * Slide a window of `oldTextLines.length` lines across fileLines and score each window
 * using per-line LCS ratio. Returns up to FUZZY_MAX_SUGGESTIONS best matches above threshold.
 */
export function scoreWindows(fileLines: string[], oldTextLines: string[]): ScoredWindow[] {
  const windowSize = oldTextLines.length;
  if (windowSize === 0 || fileLines.length === 0) {
    return [];
  }

  const results: ScoredWindow[] = [];
  const maxStart = fileLines.length - windowSize;
  const oldTrimmedLower = oldTextLines.map((l) => l.trimEnd().toLowerCase());
  const shouldPreFilter = windowSize > 1;

  for (let start = 0; start <= maxStart; start++) {
    if (shouldPreFilter) {
      // Pre-filter: require >= 30% of lines to share a short substring with oldText.
      // Sample prefix/middle/suffix chunks so renamed leading tokens still survive.
      let preFilterHits = 0;
      for (let i = 0; i < windowSize; i++) {
        const fileLine = fileLines[start + i].trimEnd().toLowerCase();
        const oldLine = oldTrimmedLower[i];
        if (hasSharedPreFilterChunk(fileLine, oldLine)) {
          preFilterHits++;
        }
      }
      if (preFilterHits < windowSize * 0.3) {
        continue;
      }
    }

    // Full LCS scoring
    let totalScore = 0;
    for (let i = 0; i < windowSize; i++) {
      totalScore += lcsRatio(oldTextLines[i].trimEnd(), fileLines[start + i].trimEnd());
    }
    const avgScore = totalScore / windowSize;

    if (avgScore >= FUZZY_MIN_SIMILARITY) {
      results.push({
        startLine: start + 1,
        endLine: start + windowSize,
        score: avgScore,
        lines: fileLines.slice(start, start + windowSize),
      });
    }
  }

  results.sort((a, b) => b.score - a.score || a.startLine - b.startLine);
  return results.slice(0, FUZZY_MAX_SUGGESTIONS);
}

/** Format scored windows into a human-readable error message with line numbers. */
function formatSuggestions(
  candidates: ScoredWindow[],
  fileLines: string[],
  filePath: string,
): string {
  const totalLines = fileLines.length;
  if (candidates.length === 0) {
    return (
      `Could not find the exact text in ${filePath}.\n\n` +
      `The file has ${totalLines} lines. No similar regions found ` +
      `(similarity < ${Math.round(FUZZY_MIN_SIMILARITY * 100)}%).\n` +
      `Consider re-reading the file with the read tool to get current content.`
    );
  }

  const parts: string[] = [
    `Could not find the exact text in ${filePath}.\n`,
    `The ${candidates.length} most similar region${candidates.length > 1 ? "s" : ""} in the file:\n`,
  ];
  let totalChars = parts.join("").length;

  for (const candidate of candidates) {
    const header = `--- Lines ${candidate.startLine}-${candidate.endLine} (similarity: ${Math.round(candidate.score * 100)}%) ---\n`;
    const ctxStart = Math.max(0, candidate.startLine - 1 - FUZZY_CONTEXT_LINES);
    const ctxEnd = Math.min(fileLines.length, candidate.endLine + FUZZY_CONTEXT_LINES);
    const snippet = fileLines
      .slice(ctxStart, ctxEnd)
      .map((line, i) => {
        const lineNum = ctxStart + i + 1;
        const prefix = lineNum >= candidate.startLine && lineNum <= candidate.endLine ? ">" : " ";
        return `${prefix} ${String(lineNum).padStart(4)} │ ${line}`;
      })
      .join("\n");

    const block = header + snippet + "\n\n";
    if (totalChars + block.length > FUZZY_MAX_OUTPUT_CHARS) {
      parts.push("(additional matches truncated)\n");
      break;
    }
    parts.push(block);
    totalChars += block.length;
  }

  parts.push(
    "Hint: Compare the shown regions with your oldText. " +
      "Check for whitespace differences, renamed variables, or recent file changes.",
  );
  return parts.join("");
}

/** Returns true if content appears to be binary (contains null bytes in the first 8KB). */
function isBinaryContent(content: string): boolean {
  const checkLen = Math.min(content.length, FUZZY_BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (content.charCodeAt(i) === 0) {
      return true;
    }
  }
  return false;
}

// ─── Fuzzy Match Suggestion Wrapper ───

const NOT_FOUND_PATTERN = /Could not find the exact text in /;

/**
 * Wraps an edit tool to enrich "oldText not found" errors with fuzzy match suggestions.
 * When the upstream edit fails because oldText doesn't match, this reads the file and returns
 * the closest matching regions with line numbers and similarity scores, so the model can
 * self-correct in one shot. Zero overhead on success — only activates on not-found errors.
 */
export function wrapEditToolWithFuzzyMatchSuggestions(
  base: AnyAgentTool,
  root: string,
  options?: FuzzyMatchSuggestionOptions,
): AnyAgentTool {
  const readFile: FuzzyMatchReadFile =
    options?.readFile ??
    ((absolutePath, signal) => fs.readFile(absolutePath, { encoding: "utf-8", signal }));
  const statFile =
    options?.stat ?? ((absolutePath: string) => fs.stat(absolutePath) as Promise<FuzzyMatchStat>);

  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        if (!(err instanceof Error) || !NOT_FOUND_PATTERN.test(err.message)) {
          throw err;
        }

        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
        const pathParam = record && typeof record.path === "string" ? record.path : undefined;
        const oldText =
          record && typeof record.oldText === "string"
            ? record.oldText
            : record && typeof record.old_string === "string"
              ? record.old_string
              : undefined;

        if (!pathParam || !oldText) {
          throw err;
        }

        try {
          const absolutePath = resolveHostEditPath(root, pathParam);

          // Check file size before reading to avoid loading huge files into memory.
          const stat = await statFile(absolutePath, signal);
          if (!stat) {
            throw new Error(`File not found: ${absolutePath}`, { cause: err });
          }
          if (stat.size > FUZZY_MAX_FILE_SIZE_BYTES) {
            throw new Error(
              `Could not find the exact text in ${pathParam}.\n\n` +
                `File is large (${Math.round(stat.size / 1024)}KB). ` +
                `Fuzzy matching skipped for performance. ` +
                `Consider re-reading the relevant section with the read tool.`,
              { cause: err },
            );
          }

          const rawContent = await readFile(absolutePath, signal);
          const content =
            typeof rawContent === "string" ? rawContent : rawContent.toString("utf-8");

          if (isBinaryContent(content)) {
            throw new Error(
              `File ${pathParam} appears to be binary. The edit tool only works with text files.`,
              { cause: err },
            );
          }

          const fileLines = content.split("\n");
          const oldTextLines = oldText.split("\n");
          const candidates = scoreWindows(fileLines, oldTextLines);
          throw new Error(formatSuggestions(candidates, fileLines, pathParam), { cause: err });
        } catch (innerErr) {
          // Only surface enriched errors (our own throws with { cause: err }).
          // For unexpected FS errors (ENOENT, EACCES, race conditions), fall back
          // to the original "not found" error so we don't mask the real issue.
          if (innerErr instanceof Error && innerErr.cause === err) {
            throw innerErr;
          }
          throw err;
        }
      }
    },
  };
}
