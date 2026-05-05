import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
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

function resolveEditPath(root: string, pathParam: string): string {
  const home = resolveOsHomeDir();
  const expanded = home ? expandHomePrefix(pathParam, { home }) : pathParam;
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
  const record = getToolParamsRecord(params);
  return {
    pathParam: readStringParam(record, "path"),
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

// Detects the "concurrent identical edits, follower request" case: the file is
// unchanged compared to before the call AND already in the target state for
// every edit (newText present, oldText absent). The leader request mutated the
// file before this follower's `base.execute(...)` ran, so the underlying tool
// sees `oldText` missing and throws an "exact-match" mismatch — but the file
// IS at the desired final state. Return a noop result instead of either a
// false success (claims work was performed) or an error (claims failure).
// See [GitHub #60816].
function isFileAlreadyInTargetState(params: {
  originalContent?: string;
  currentContent: string;
  edits: EditReplacement[];
}): boolean {
  if (params.edits.length === 0) {
    return false;
  }
  if (typeof params.originalContent !== "string") {
    // Without a snapshot we cannot distinguish "this request did the work"
    // from "another writer landed it". Defer to the existing success/error
    // recovery branches.
    return false;
  }
  const normalizedOriginal = normalizeToLF(params.originalContent);
  const normalizedCurrent = normalizeToLF(params.currentContent);
  if (normalizedOriginal !== normalizedCurrent) {
    return false;
  }
  for (const edit of params.edits) {
    const normalizedNew = normalizeToLF(edit.newText);
    const normalizedOld = normalizeToLF(edit.oldText);
    if (normalizedNew.length > 0 && !normalizedCurrent.includes(normalizedNew)) {
      return false;
    }
    if (normalizedOld.length > 0 && normalizedCurrent.includes(normalizedOld)) {
      return false;
    }
  }
  return true;
}

function buildEditNoopResult(pathParam: string): AgentToolResult<unknown> {
  return {
    isError: false,
    content: [
      {
        type: "text",
        text: `Edit noop: content already up to date in ${pathParam}.`,
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
 * Recover from three edit-tool result classes without changing edit semantics:
 * - post-write throws are converted back to success only if the file actually changed
 * - concurrent identical edits where the follower finds the file already in the
 *   target state are reported as a noop, distinct from both success and error
 * - exact-match mismatch errors become actionable by including current file contents
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
          if (
            isFileAlreadyInTargetState({
              originalContent,
              currentContent,
              edits,
            })
          ) {
            return buildEditNoopResult(pathParam ?? absolutePath);
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
