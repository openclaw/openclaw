import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type EditToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
};

type WriteToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
  statFile?: (absolutePath: string) => Promise<WriteToolFileStat | null>;
};

type WriteToolParams = {
  pathParam?: string;
  content?: string;
};

type WriteToolFileStat = {
  type: "file" | "directory" | "other";
  size: number;
  mtimeMs?: number;
};

type WriteToolOriginalState = "different" | "same" | "unknown";

type WriteToolPrecheck = {
  state: WriteToolOriginalState;
  beforeStat?: WriteToolFileStat | null;
};

type EditToolParams = {
  pathParam?: string;
  edits: EditReplacement[];
};

type EditReplacement = {
  oldText: string;
  newText: string;
};

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;
const WRITE_PRECHECK_READ_LIMIT_BYTES = 1024 * 1024;
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeMutationPathLikeUpstreamWrite(pathParam: string): string {
  let normalized = pathParam.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) {
    normalized = normalized.slice(1);
  }
  const home = resolveOsHomeDir();
  const expanded = home ? expandHomePrefix(normalized, { home }) : normalized;
  if (expanded.startsWith("file://")) {
    try {
      return fileURLToPath(expanded);
    } catch {
      return expanded;
    }
  }
  return expanded;
}

function resolveFileMutationPath(root: string, pathParam: string): string {
  const expanded = normalizeMutationPathLikeUpstreamWrite(pathParam);
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

function readEditReplacements(record: Record<string, unknown> | undefined): EditReplacement[] {
  if (!Array.isArray(record?.edits)) {
    return [];
  }
  return record.edits.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const replacement = entry as Record<string, unknown>;
    if (typeof replacement.oldText !== "string" || replacement.oldText.trim().length === 0) {
      return [];
    }
    if (typeof replacement.newText !== "string") {
      return [];
    }
    return [{ oldText: replacement.oldText, newText: replacement.newText }];
  });
}

function readWriteToolParams(params: unknown): WriteToolParams {
  const record = getToolParamsRecord(params);
  return {
    pathParam: readStringParam(record, "path", "file_path", "filePath", "filepath", "file"),
    content: typeof record?.content === "string" ? record.content : undefined,
  };
}

function readEditToolParams(params: unknown): EditToolParams {
  const record = getToolParamsRecord(params);
  return {
    pathParam: readStringParam(record, "path", "file_path", "filePath", "filepath", "file"),
    edits: readEditReplacements(record),
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
  edits: EditReplacement[];
}) {
  if (params.edits.length === 0) {
    return false;
  }
  const normalizedCurrent = normalizeToLF(params.currentContent);
  const normalizedOriginal =
    typeof params.originalContent === "string" ? normalizeToLF(params.originalContent) : undefined;

  if (normalizedOriginal !== undefined && normalizedOriginal === normalizedCurrent) {
    return false;
  }

  let withoutInsertedNewText = normalizedCurrent;
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
    withoutInsertedNewText =
      normalizedNew.length > 0
        ? removeExactOccurrences(withoutInsertedNewText, normalizedNew)
        : withoutInsertedNewText;
  }

  for (const edit of params.edits) {
    const normalizedOld = normalizeToLF(edit.oldText);
    if (withoutInsertedNewText.includes(normalizedOld)) {
      return false;
    }
  }

  return true;
}

function buildEditSuccessResult(pathParam: string, editCount: number): AgentToolResult<unknown> {
  const text =
    editCount > 1
      ? `Successfully replaced ${editCount} block(s) in ${pathParam}.`
      : `Successfully replaced text in ${pathParam}.`;
  return {
    isError: false,
    content: [
      {
        type: "text",
        text,
      },
    ],
    details: { diff: "", firstChangedLine: undefined },
  } as AgentToolResult<unknown>;
}

function buildWriteSuccessResult(pathParam: string, content: string): AgentToolResult<unknown> {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Successfully wrote ${content.length} bytes to ${pathParam}`,
      },
    ],
    details: undefined,
  } as AgentToolResult<unknown>;
}

function shouldAddMismatchHint(error: unknown) {
  return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}

/**
 * Count shared leading lines between two strings (case-sensitive, whitespace-exact).
 */
function countSharedLines(a: string, b: string): number {
  const aLines = a.split("\n");
  const bLines = b.split("\n");
  let shared = 0;
  const limit = Math.min(aLines.length, bLines.length);
  for (let i = 0; i < limit; i++) {
    if (aLines[i] === bLines[i]) {
      shared++;
    } else {
      break;
    }
  }
  return shared;
}

/**
 * Find the file region most similar to `needle` using a line-based sliding
 * window.  Returns the best-matching region with line numbers so the model
 * can see *where* its oldText diverged.
 */
function findBestMatchRegion(
  content: string,
  needle: string,
  maxLen: number,
): { snippet: string; startLine: number } | undefined {
  if (content.length === 0 || needle.length === 0) {
    return undefined;
  }
  const contentLines = content.split("\n");
  const needleLines = needle.split("\n");
  const windowSize = needleLines.length;

  let bestScore = 0;
  let bestStart = 0;

  for (let i = 0; i <= contentLines.length - windowSize; i++) {
    const candidate = contentLines.slice(i, i + windowSize).join("\n");
    const score = countSharedLines(candidate, needle);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }

  // No meaningful match — fall back to undefined so caller uses full file head
  if (bestScore === 0) {
    return undefined;
  }

  // Add a small context margin (2 lines above/below)
  const ctxBefore = Math.max(0, bestStart - 2);
  const ctxAfter = Math.min(contentLines.length, bestStart + windowSize + 2);
  let snippet = contentLines
    .slice(ctxBefore, ctxAfter)
    .map((line, idx) => `${ctxBefore + idx + 1} | ${line}`)
    .join("\n");
  if (snippet.length > maxLen) {
    snippet = `${snippet.slice(0, maxLen)}\n... (truncated)`;
  }
  return { snippet, startLine: ctxBefore + 1 };
}

function appendMismatchHint(
  error: Error,
  currentContent: string,
  edits: EditReplacement[],
): Error {
  const failedEdit = edits.find(
    (e) => !normalizeToLF(currentContent).includes(normalizeToLF(e.oldText)),
  );

  // Try to locate the closest region to the failed oldText
  const bestRegion =
    failedEdit &&
    findBestMatchRegion(
      normalizeToLF(currentContent),
      normalizeToLF(failedEdit.oldText),
      EDIT_MISMATCH_HINT_LIMIT,
    );

  let hint: string;
  if (bestRegion) {
    hint =
      `Best matching region (lines ${bestRegion.startLine}+):\n` +
      bestRegion.snippet;
  } else {
    const snippet =
      currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
        ? currentContent
        : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
    hint = `Current file contents:\n${snippet}`;
  }

  const enhanced = new Error(`${error.message}\n${hint}`);
  enhanced.stack = error.stack;
  return enhanced;
}

function isWriteRecoveryCandidate(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function isMissingFileError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && (error as { code?: unknown }).code === "ENOENT") {
    return true;
  }
  return error instanceof Error && error.message.includes("No such file or directory");
}

async function readOriginalWriteState(
  absolutePath: string,
  content: string,
  options: WriteToolRecoveryOptions,
): Promise<WriteToolPrecheck> {
  if (!options.statFile) {
    return { state: "unknown" };
  }
  const contentBytes = Buffer.byteLength(content, "utf8");
  let stat: WriteToolFileStat | null;
  try {
    stat = await options.statFile(absolutePath);
  } catch (err) {
    return { state: isMissingFileError(err) ? "different" : "unknown" };
  }
  if (!stat) {
    return { state: "different", beforeStat: stat };
  }
  if (stat.type !== "file") {
    return { state: "unknown", beforeStat: stat };
  }
  if (stat.size !== contentBytes) {
    return { state: "different", beforeStat: stat };
  }
  if (stat.size > WRITE_PRECHECK_READ_LIMIT_BYTES) {
    return { state: "unknown", beforeStat: stat };
  }

  try {
    const originalContent = await options.readFile(absolutePath);
    return { state: originalContent === content ? "same" : "different", beforeStat: stat };
  } catch {
    return { state: "unknown", beforeStat: stat };
  }
}

async function didWriteMetadataChange(
  absolutePath: string,
  beforeStat: WriteToolFileStat | null | undefined,
  options: WriteToolRecoveryOptions,
): Promise<boolean> {
  if (!beforeStat || !options.statFile) {
    return false;
  }
  let afterStat: WriteToolFileStat | null;
  try {
    afterStat = await options.statFile(absolutePath);
  } catch {
    return false;
  }
  if (!afterStat || afterStat.type !== "file") {
    return false;
  }
  return afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs;
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
      const { pathParam, edits } = readEditToolParams(params);
      const absolutePath =
        typeof pathParam === "string"
          ? resolveFileMutationPath(options.root, pathParam)
          : undefined;
      let originalContent: string | undefined;

      if (absolutePath && edits.length > 0) {
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

        if (typeof currentContent === "string" && edits.length > 0) {
          if (
            didEditLikelyApply({
              originalContent,
              currentContent,
              edits,
            })
          ) {
            return buildEditSuccessResult(pathParam ?? absolutePath, edits.length);
          }
        }

        if (
          typeof currentContent === "string" &&
          err instanceof Error &&
          shouldAddMismatchHint(err)
        ) {
          throw appendMismatchHint(err, currentContent, edits);
        }

        throw err;
      }
    },
  };
}

/**
 * Recover write calls that complete the disk write but abort before returning.
 * Readback is the source of truth; argument-derived paths never prove success.
 */
export function wrapWriteToolWithRecovery(
  base: AnyAgentTool,
  options: WriteToolRecoveryOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<unknown>,
    ) => {
      const { pathParam, content } = readWriteToolParams(params);
      const absolutePath =
        typeof pathParam === "string" && typeof content === "string"
          ? resolveFileMutationPath(options.root, pathParam)
          : undefined;
      const precheck: WriteToolPrecheck =
        absolutePath && typeof content === "string"
          ? await readOriginalWriteState(absolutePath, content, options)
          : { state: "unknown" };

      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
        if (
          !isWriteRecoveryCandidate(err, signal) ||
          typeof absolutePath !== "string" ||
          typeof pathParam !== "string" ||
          typeof content !== "string"
        ) {
          throw err;
        }
        let currentContent: string | undefined;
        try {
          currentContent = await options.readFile(absolutePath);
        } catch {
          // Fall through to the original abort if readback fails.
        }
        const changed =
          precheck.state === "different" ||
          (precheck.state === "unknown" &&
            (await didWriteMetadataChange(absolutePath, precheck.beforeStat, options)));
        if (currentContent === content && changed) {
          return buildWriteSuccessResult(pathParam, content);
        }
        throw err;
      }
    },
  };
}
