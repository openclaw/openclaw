import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { AnyAgentTool } from "./pi-tools.types.js";

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
      // Capture pre-edit file content so the recovery check can detect whether the file
      // actually changed. Without this, pre-existing newText in the file could trick the
      // heuristic into reporting success even when the upstream tool threw before writing.
      const record =
        params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
      const pathParam = record && typeof record.path === "string" ? record.path : undefined;
      let contentBefore: string | undefined;
      if (pathParam) {
        try {
          const absolutePath = resolveHostEditPath(root, pathParam);
          contentBefore = await fs.readFile(absolutePath, "utf-8");
        } catch {
          // File may not exist yet; leave contentBefore undefined.
        }
      }

      try {
        return await base.execute(toolCallId, params, signal, onUpdate);
      } catch (err) {
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
          // If the file content is identical to what it was before the edit call, the
          // upstream tool threw before writing anything — rethrow immediately.
          if (contentBefore !== undefined && content === contentBefore) {
            throw err;
          }
          // Use before/after occurrence counts when contentBefore is available. This is
          // more robust than stripping newText from the content, which can produce false
          // positives when newText pre-existed in the file (review feedback on #49639).
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

          const hasNew = content.includes(newText);
          const newTextCountAfter = countOccurrences(content, newText);
          const newTextCountBefore =
            contentBefore !== undefined ? countOccurrences(contentBefore, newText) : 0;
          // Evidence the edit added at least one new occurrence of newText.
          const editAddedNewText = newTextCountAfter > newTextCountBefore;

          // For oldText checking, strip newText occurrences to handle the case where
          // oldText is a substring of newText (e.g. appending/wrapping, #49363).
          const stripNewText = (s: string): string =>
            oldText !== undefined && oldText.length > 0 && newText.includes(oldText)
              ? s.replaceAll(newText, "")
              : s;
          const stillHasOld =
            oldText !== undefined && oldText.length > 0 && stripNewText(content).includes(oldText);
          // When contentBefore is available, also check that oldText count decreased.
          const oldTextDecreasedOrAbsent =
            !stillHasOld &&
            (contentBefore === undefined ||
              countOccurrences(stripNewText(content), oldText ?? "") <=
                countOccurrences(stripNewText(contentBefore), oldText ?? ""));

          // Recover only when we have evidence the edit wrote something new AND oldText
          // is no longer present (or decreased). When contentBefore is available, require
          // that newText count increased to avoid false positives from pre-existing newText.
          const recovered =
            hasNew && oldTextDecreasedOrAbsent && (contentBefore === undefined || editAddedNewText);
          if (recovered) {
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
        } catch (innerErr) {
          // If innerErr is the original error we explicitly re-threw, propagate it.
          if (innerErr === err) {
            throw err;
          }
          // File read failed or path invalid; rethrow original error.
        }
        throw err;
      }
    },
  };
}
