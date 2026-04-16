/**
 * Plan-mode mutation gate.
 *
 * When plan mode is active ("plan"), this hook blocks mutation tools
 * so the agent can only read, search, and plan — not execute changes.
 * The agent must call `exit_plan_mode` to request user approval before
 * mutation tools become available.
 *
 * Design ported from PR #61845's plan-mode-hook.ts but implemented
 * independently against current main.
 */

import type { PlanMode } from "./types.js";

/**
 * Tools blocked during plan mode unless handled by a special case below
 * (e.g. exec has a read-only prefix allowlist).
 */
const MUTATION_TOOL_BLOCKLIST = new Set([
  "apply_patch",
  "bash",
  "edit",
  "exec",
  "gateway",
  "message",
  "nodes",
  "process",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "write",
]);

/** Suffix patterns that also indicate mutation tools. */
const MUTATION_SUFFIX_PATTERNS = [".write", ".edit", ".delete"];

/** Tools explicitly allowed during plan mode (bypass blocklist check). */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  "read",
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
  "update_plan",
  "exit_plan_mode",
  "session_status",
]);

/**
 * Read-only exec commands allowed during plan mode.
 * If exec is called with a command starting with one of these prefixes,
 * the call is allowed. Otherwise exec is blocked.
 */
const READ_ONLY_EXEC_PREFIXES = [
  "ls", "cat", "pwd", "git status", "git log", "git diff", "git show",
  "which", "find", "grep", "rg", "head", "tail", "wc", "file", "stat",
  "du", "df", "echo", "printenv", "env", "whoami", "hostname", "uname",
];

export interface MutationGateResult {
  blocked: boolean;
  reason?: string;
}

/**
 * Checks whether a tool call should be blocked during plan mode.
 *
 * @param toolName - The tool name being called (case-insensitive)
 * @param currentMode - The current plan mode state
 * @param execCommand - If the tool is `exec`, the command string to check
 *                      against the read-only prefix whitelist
 */
export function checkMutationGate(
  toolName: string,
  currentMode: PlanMode,
  execCommand?: string,
): MutationGateResult {
  // Normal mode: nothing blocked.
  if (currentMode !== "plan") {
    return { blocked: false };
  }

  const normalized = toolName.trim().toLowerCase();

  // Explicitly allowed tools always pass.
  if (PLAN_MODE_ALLOWED_TOOLS.has(normalized)) {
    return { blocked: false };
  }

  // Special case: exec/bash with a read-only command prefix is allowed,
  // but reject commands containing shell compound operators first.
  if ((normalized === "exec" || normalized === "bash") && execCommand) {
    const cmd = execCommand.trim().toLowerCase();
    // Block shell compound operators that could chain arbitrary commands.
    if (/[;|&`]|\$\(|>>?/.test(cmd)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" command contains shell operators and is blocked in plan mode. ` +
          "Only simple read-only commands are allowed.",
      };
    }
    const isReadOnly = READ_ONLY_EXEC_PREFIXES.some(
      (prefix) => cmd === prefix || cmd.startsWith(prefix + " "),
    );
    if (isReadOnly) {
      return { blocked: false };
    }
  }

  // Check exact blocklist.
  if (MUTATION_TOOL_BLOCKLIST.has(normalized)) {
    return {
      blocked: true,
      reason:
        `Tool "${toolName}" is blocked in plan mode. ` +
        "Mutation tools stay blocked until the current plan is confirmed. " +
        "Call exit_plan_mode after user confirmation, or revise the plan with update_plan.",
    };
  }

  // Check suffix patterns.
  for (const suffix of MUTATION_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" matches mutation suffix pattern "${suffix}" and is blocked in plan mode. ` +
          "Call exit_plan_mode to proceed.",
      };
    }
  }

  // Default deny: unknown tools are blocked in plan mode to prevent
  // newly added or plugin tools from bypassing the mutation gate.
  return {
    blocked: true,
    reason:
      `Tool "${toolName}" is not in the plan-mode allowlist and is blocked by default. ` +
      "Call exit_plan_mode to proceed.",
  };
}
