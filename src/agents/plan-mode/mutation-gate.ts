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
 *
 * PR-10 review fix (Copilot/Codex P1 #3105169112): `sessions_spawn`
 * was previously on this blocklist, which broke the documented
 * plan-mode workflow ("spawn research subagents during plan-mode
 * investigation, then synthesize the plan"). Removed — subagent
 * spawning is a research operation, not a workspace mutation. The
 * subagent's own runtime applies its own plan-mode gate if/when
 * needed.
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
  // "sessions_spawn",  // removed per PR-10 review #3105169112
  "subagents",
  "write",
]);

/** Suffix patterns that also indicate mutation tools. */
const MUTATION_SUFFIX_PATTERNS = [".write", ".edit", ".delete"];

/** Suffix patterns that indicate read-only tools (bypass fail-closed default). */
const READONLY_SUFFIX_PATTERNS = [".read", ".search", ".list", ".get", ".view"];

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
  // PR-10 review fix (Copilot/Codex P1 #3104741578 / #3104743331):
  // ask_user_question is a planning-time clarification tool that
  // does NOT exit plan mode and does NOT mutate workspace state. It
  // must be in the allowlist or the entire feature is broken under
  // the default-deny gate.
  "ask_user_question",
  // enter_plan_mode is also non-mutating (state transition only) and
  // should be allowed even when called redundantly mid-plan.
  "enter_plan_mode",
  // sessions_spawn allowed for research-subagent flows (see comment
  // on MUTATION_TOOL_BLOCKLIST above). Belt-and-suspenders allowlist
  // entry in addition to the blocklist removal.
  "sessions_spawn",
  // Iter-3 D6 followup: read-only plan-mode introspection — must be
  // allowed in plan mode (the most important place to call it). The
  // tool is purely read; no state mutation. Without this entry, the
  // default-deny gate blocks the agent from self-diagnosing while in
  // plan mode, defeating the entire point of the introspection
  // surface. (User-reported regression: agent called plan_mode_status
  // mid-pending-approval and got "Tool not in plan-mode allowlist".)
  "plan_mode_status",
  // Read-only sessions tools — useful during plan-mode investigation
  // and the agent shouldn't have to learn they're allowed.
  "sessions_list",
  "sessions_history",
]);

/**
 * Read-only exec commands allowed during plan mode.
 * If exec is called with a command starting with one of these prefixes,
 * the call is allowed. Otherwise exec is blocked.
 */
const READ_ONLY_EXEC_PREFIXES = [
  "ls",
  "cat",
  "pwd",
  "git status",
  "git log",
  "git diff",
  "git show",
  "which",
  "find",
  "grep",
  "rg",
  "head",
  "tail",
  "wc",
  "file",
  "stat",
  "du",
  "df",
  "echo",
  "printenv",
  "whoami",
  "hostname",
  "uname",
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
    // Block shell compound operators, newlines, process substitution, and
    // other metacharacters that could chain or redirect commands.
    if (/[;|&`\n\r]|\$\(|>>?|<\(|>\(/.test(cmd)) {
      return {
        blocked: true,
        reason:
          `Tool "${toolName}" command contains shell operators or newlines and is blocked in plan mode. ` +
          "Only simple read-only commands are allowed.",
      };
    }
    // Block dangerous flags on otherwise-allowed commands.
    // Uses word-boundary regex to avoid false matches on substrings
    // (e.g., -executable should not match -exec). Tabs are treated as
    // whitespace separators alongside spaces.
    // PR-D review fix (Copilot #3096526195 / #3105045300): `find` is in
    // the read-only prefix allowlist but several `find` flags actually
    // write files: `-fprint <file>`, `-fprint0 <file>`, `-fprintf <file>
    // <fmt>`, `-fls <file>`. Add to the dangerous-flag set so a command
    // like `find . -fprint /tmp/out.txt` is blocked in plan mode rather
    // than silently mutating the filesystem.
    const DANGEROUS_FLAGS = [
      "-delete",
      "-exec",
      "-execdir",
      "--delete",
      "-rf",
      "--output",
      "-fprint",
      "-fprint0",
      "-fprintf",
      "-fls",
    ];
    const hasFlag = DANGEROUS_FLAGS.some((f) => {
      const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[\\s])${escaped}(?:[\\s=]|$)`, "i").test(cmd);
    });
    if (hasFlag) {
      return {
        blocked: true,
        reason: `Tool "${toolName}" command contains a dangerous flag and is blocked in plan mode.`,
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

  // Check read-only suffix patterns — allow MCP read tools like custom.read, data.search.
  for (const suffix of READONLY_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return { blocked: false };
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
