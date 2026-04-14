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
  // Normalize to match what the write/patch path resolution pipeline does:
  // 1. Strip leading @ (normalizeAtPrefix in sandbox-paths.ts)
  // 2. Strip unicode space variants (normalizeUnicodeSpaces)
  // 3. Strip trailing dots/spaces (Windows aliases: SOUL.md. → SOUL.md)
  let normalized = filePath.replace(/^@/, "");
  normalized = path.basename(normalized).toLowerCase().replace(/[\s.]+$/, "");
  // Also strip common unicode space chars that normalizeUnicodeSpaces handles
  normalized = normalized.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, "");
  return PROTECTED_BASENAMES.has(normalized);
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
