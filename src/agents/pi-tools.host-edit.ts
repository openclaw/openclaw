import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { normalizeToolParams } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

type EditToolRecoveryOptions = {
  root: string;
  readFile: (absolutePath: string) => Promise<string>;
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

function readEditToolParams(params: unknown): EditToolParams {
  const normalized = normalizeToolParams(params);
  const record =
    normalized ??
    (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
  return {
    pathParam: readStringParam(record, "path", "file_path", "filePath", "file"),
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

  // Use before/after occurrence counts for more robust detection.
  // This handles the case where newText pre-existed in the file.
  const countOccurrences = (hay: string, needle: string): number => {
    if (needle.length === 0) {
      return 0;
    }
    let count = 0;
    let idx = 0;
    while ((idx = hay.indexOf(needle, idx)) !== -1) {
      count++;
      idx += needle.length;
    }
    return count;
  };

  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    const normalizedOld = normalizeToLF(edit.oldText);

    // Check if newText exists in current content
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }

    // Count occurrences before and after
    const newTextCountAfter = countOccurrences(normalizedCurrent, normalizedNew);
    const newTextCountBefore =
      normalizedOriginal !== undefined ? countOccurrences(normalizedOriginal, normalizedNew) : 0;

    // Evidence the edit added at least one new occurrence of newText
    const editAddedNewText = newTextCountAfter > newTextCountBefore;

    // For oldText checking, strip newText occurrences to handle the case where
    // oldText is a substring of newText (e.g. appending/wrapping, #49363)
    const stripNewText = (s: string): string =>
      normalizedOld.length > 0 && normalizedNew.includes(normalizedOld)
        ? s.split(normalizedNew).join("")
        : s;

    const contentAfterStrip = stripNewText(normalizedCurrent);
    const stillHasOld = normalizedOld.length > 0 && contentAfterStrip.includes(normalizedOld);

    // When original is available, check that oldText count decreased
    const oldTextDecreasedOrAbsent =
      !stillHasOld &&
      (normalizedOriginal === undefined ||
        countOccurrences(stripNewText(normalizedCurrent), normalizedOld) <=
          countOccurrences(stripNewText(normalizedOriginal), normalizedOld));

    // Recover only when: newText added AND oldText decreased/absent
    const recovered = editAddedNewText && oldTextDecreasedOrAbsent;
    if (!recovered) {
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

function shouldAddMismatchHint(error: unknown) {
  return error instanceof Error && error.message.includes(EDIT_MISMATCH_MESSAGE);
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${currentContent.slice(0, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`);
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
      const { pathParam, edits } = readEditToolParams(params);
      const absolutePath =
        typeof pathParam === "string" ? resolveEditPath(options.root, pathParam) : undefined;
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
          throw appendMismatchHint(err, currentContent);
        }

        throw err;
      }
    },
  };
}
