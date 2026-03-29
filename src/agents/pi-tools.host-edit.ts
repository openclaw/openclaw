import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

type EditToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
};

type EditToolParams = {
  pathParam?: string;
  oldText?: string;
  newText?: string;
};

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;

/** Resolve path for edit recovery: expand ~ and resolve relative paths against root. */
function resolveEditPath(root: string, pathParam: string): string {
  const expanded =
    pathParam.startsWith("~/") || pathParam === "~"
      ? pathParam.replace(/^~/, os.homedir())
      : pathParam;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function readStringParam(record: Record<string, unknown> | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function readEditToolParams(params: unknown): EditToolParams {
  const record =
    params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
  return {
    pathParam: readStringParam(record, "path", "file_path", "file"),
    oldText: readStringParam(record, "oldText", "old_string", "old_text", "oldString"),
    newText: readStringParam(record, "newText", "new_string", "new_text", "newString"),
  };
}

function normalizeToLF(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function removeExactOccurrences(content: string, needle: string): string {
  return needle.length > 0 ? content.split(needle).join("") : content;
}

function didEditLikelyApply(params: {
  originalContent?: string;
  currentContent: string;
  oldText?: string;
  newText: string;
}) {
  const normalizedCurrent = normalizeToLF(params.currentContent);
  const normalizedNew = normalizeToLF(params.newText);
  const normalizedOld =
    typeof params.oldText === "string" && params.oldText.length > 0
      ? normalizeToLF(params.oldText)
      : undefined;
  const normalizedOriginal =
    typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : undefined;

  if (normalizedOriginal !== undefined && normalizedOriginal === normalizedCurrent) {
    return false;
  }

  if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
    return false;
  }

  const withoutInsertedNewText =
    normalizedNew.length > 0
      ? removeExactOccurrences(normalizedCurrent, normalizedNew)
      : normalizedCurrent;
  if (normalizedOld && withoutInsertedNewText.includes(normalizedOld)) {
    return false;
  }

  return true;
}

function buildEditSuccessResult(pathParam: string): AgentToolResult<unknown> {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Successfully replaced text in ${pathParam}.`,
      },
    ],
    details: { diff: "", firstChangedLine: undefined },
  } as AgentToolResult<unknown>;
}

function shouldAddMismatchHint(error: unknown) {
  return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}

/**
 * Find the most similar region in the file to the given oldText using
 * line-level similarity scoring. Returns the best matching line range
 * with a context snippet so the model can self-correct.
 */
function findBestMatchRegion(
  content: string,
  oldText: string,
): { lineStart: number; snippet: string; score: number } | null {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0 || contentLines.length === 0) {
    return null;
  }

  let bestScore = 0;
  let bestStart = 0;

  // Slide a window the size of oldText lines across the file
  const windowSize = oldLines.length;
  for (let start = 0; start <= contentLines.length - windowSize; start++) {
    let matching = 0;
    for (let j = 0; j < windowSize; j++) {
      const contentLine = contentLines[start + j].trimEnd();
      const oldLine = oldLines[j].trimEnd();
      if (contentLine === oldLine) {
        matching++;
      } else if (
        contentLine.trim() === oldLine.trim() ||
        contentLine.includes(oldLine.trim()) ||
        oldLine.includes(contentLine.trim())
      ) {
        matching += 0.5;
      }
    }
    const score = matching / windowSize;
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }

  // Also try single-line match for single-line oldText in multi-line files
  if (windowSize === 1) {
    const trimmedOld = oldLines[0].trim();
    if (trimmedOld.length > 0) {
      for (let i = 0; i < contentLines.length; i++) {
        if (contentLines[i].includes(trimmedOld)) {
          return {
            lineStart: i + 1,
            snippet: contentLines
              .slice(Math.max(0, i - 1), i + 2)
              .map((l, idx) => `${Math.max(1, i) + idx}| ${l}`)
              .join("\n"),
            score: 0.9,
          };
        }
      }
    }
  }

  // Only return if the match is somewhat meaningful (>20% line overlap)
  if (bestScore < 0.2) {
    return null;
  }

  const contextStart = Math.max(0, bestStart - 1);
  const contextEnd = Math.min(contentLines.length, bestStart + windowSize + 1);
  const snippet = contentLines
    .slice(contextStart, contextEnd)
    .map((l, idx) => `${contextStart + idx + 1}| ${l}`)
    .join("\n");

  return { lineStart: bestStart + 1, snippet, score: bestScore };
}

function appendMismatchHint(error: Error, currentContent: string, oldText?: string): Error {
  const parts: string[] = [error.message];

  // Try to find the most similar region if oldText is available
  if (oldText && oldText.length > 0) {
    const match = findBestMatchRegion(normalizeToLF(currentContent), normalizeToLF(oldText));
    if (match) {
      const pct = Math.round(match.score * 100);
      parts.push(
        `\nBest matching region (${pct}% similar) near line ${match.lineStart}:\n${match.snippet}`,
      );
      parts.push(
        "\nHint: check for whitespace differences, extra/missing lines, or outdated content in your oldText.",
      );
      const enhanced = new Error(parts.join(""));
      enhanced.stack = error.stack;
      return enhanced;
    }
  }

  // Fall back to showing file head if no similar region found
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  parts.push(`\nCurrent file contents:\n${snippet}`);
  const enhanced = new Error(parts.join(""));
  enhanced.stack = error.stack;
  return enhanced;
}

/**
 * Recover from two edit-tool failure classes without changing edit semantics:
 * - exact-match mismatch errors become actionable by including current file contents
 * - post-write throws are converted back to success only if the file actually changed
 */
export function wrapEditToolWithRecovery(
  base: AnyAgentTool,
  options: EditToolRecoveryOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      const { pathParam, oldText, newText } = readEditToolParams(params);
      const absolutePath =
        typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : undefined;
      let originalContent: string | undefined;

      if (absolutePath && newText !== undefined) {
        try {
          originalContent = await options.readFile(absolutePath);
        } catch {
          // Best-effort snapshot only; recovery should still proceed without it.
        }
      }

      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        if (!absolutePath) {
          throw err;
        }

        let currentContent: string | undefined;
        try {
          currentContent = await options.readFile(absolutePath);
        } catch {
          // Fall through to the original error if readback fails.
        }

        if (typeof currentContent === "string" && newText !== undefined) {
          if (
            didEditLikelyApply({
              originalContent,
              currentContent,
              oldText,
              newText,
            })
          ) {
            return buildEditSuccessResult(pathParam ?? absolutePath);
          }
        }

        if (
          typeof currentContent === "string" &&
          err instanceof Error &&
          shouldAddMismatchHint(err)
        ) {
          throw appendMismatchHint(err, currentContent, oldText);
        }

        throw err;
      }
    },
  };
}
