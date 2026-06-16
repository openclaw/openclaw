/**
 * Canonical names for shell-execution tools across native and Codex app-server runtimes.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const EXEC_TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  exec_command: "exec",
};

/** Normalizes shell-execution tool aliases to the OpenClaw exec policy id. */
export function normalizeExecLikeToolName(toolName: string): string {
  const normalized = normalizeOptionalLowercaseString(toolName) ?? "";
  return EXEC_TOOL_NAME_ALIASES[normalized] ?? normalized;
}

/** Detects tools that share shell-execution retry, mutation, and warning semantics. */
export function isExecLikeToolName(toolName: string): boolean {
  return normalizeExecLikeToolName(toolName) === "exec";
}
