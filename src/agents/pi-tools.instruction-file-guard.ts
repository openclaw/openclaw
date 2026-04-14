/**
 * Instruction File Write Guard
 *
 * Prevents agent sessions from overwriting their own instruction files
 * (SOUL.md, MEMORY.md, IDENTITY.md, CLAUDE.md, TOOLS.md, BOOT.md, TASKS.md)
 * without explicit operator approval. This mitigates prompt injection attacks
 * where a compromised session removes safety constraints from its own files.
 */
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getToolParamsRecord } from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

const log = createSubsystemLogger("agents/instruction-file-guard");

const PROTECTED_BASENAMES = new Set([
  "soul.md",
  "memory.md",
  "identity.md",
  "claude.md",
  "tools.md",
  "boot.md",
  "tasks.md",
]);

export function isProtectedInstructionFile(filePath: string): boolean {
  // Normalize: strip trailing dots/spaces (Windows aliases that resolve to the same file)
  const basename = path.basename(filePath).toLowerCase().replace(/[\s.]+$/, "");
  return PROTECTED_BASENAMES.has(basename);
}

export function wrapToolInstructionFileGuard(tool: AnyAgentTool): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      const filePath = typeof record?.path === "string" ? record.path.trim() : "";
      if (filePath && isProtectedInstructionFile(filePath)) {
        const basename = path.basename(filePath);
        log.warn(
          `Blocked ${tool.name} targeting protected instruction file: ${basename} (${filePath})`,
        );
        throw new Error(
          `Write to instruction file "${basename}" is blocked. ` +
            `Agent sessions cannot modify protected instruction files ` +
            `(${[...PROTECTED_BASENAMES].join(", ")}). ` +
            `Ask the operator to make this change directly.`,
        );
      }
      return execute(toolCallId, args, signal, onUpdate);
    },
  };
}
