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

/**
 * Wraps the edit tool to return current file content on oldText mismatch.
 * Implements Option 1 from https://github.com/openclaw/openclaw/issues/18132
 */
export function wrapHostEditToolWithMismatchContent(
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
      const result = (await base.execute(toolCallId, params, signal, onUpdate)) as {
        isError?: boolean;
        content: Array<{ type: string; text?: string }>;
        details?: unknown;
      };

      // Check if edit failed due to oldText mismatch
      if (
        result.isError &&
        result.content.some((b: unknown) => {
          if (typeof b === "object" && b !== null && "type" in b && "text" in b) {
            const block = b as { type: string; text: string };
            return (
              block.type === "text" &&
              block.text.toLowerCase().includes("oldtext") &&
              block.text.toLowerCase().includes("not found")
            );
          }
          return false;
        })
      ) {
        const record =
          params && typeof params === "object" ? (params as Record<string, unknown>) : undefined;
        // Use canonical path key that the edit operation validated against
        // Do NOT use file_path as it could be used to exfiltrate non-workspace files
        const pathParam = record?.path;

        if (typeof pathParam === "string") {
          try {
            const absolutePath = resolveHostEditPath(root, pathParam);
            const content = await fs.readFile(absolutePath, "utf-8");

            return {
              ...result,
              content: [
                ...result.content,
                {
                  type: "text" as const,
                  text: `\n\n--- Current file content ---\n${content}\n--- End of current content ---`,
                },
              ],
              details: result.details,
            };
          } catch {
            // File read failed; return original error
          }
        }
      }

      return result;
    },
  };
}
