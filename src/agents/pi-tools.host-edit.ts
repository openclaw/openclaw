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
 *
 * @param readFileFn - Optional custom readFile function. When provided (e.g., for sandbox mode),
 *   it will be used instead of Node.js fs.readFile. This allows the wrapper to work in sandbox
 *   environments where files exist in containers inaccessible to the host filesystem.
 */
export function wrapHostEditToolWithPostWriteRecovery(
  base: AnyAgentTool,
  root: string,
  readFileFn?: (absolutePath: string) => Promise<string>,
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
          // Use custom readFileFn if provided (e.g., for sandbox mode), otherwise fall back to fs.readFile
          const readFile = readFileFn ?? ((p: string) => fs.readFile(p, "utf-8"));
          const content = await readFile(absolutePath);
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
