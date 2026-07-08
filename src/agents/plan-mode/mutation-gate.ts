/**
 * Plan-mode mutation gate — the trusted, default-deny read-only policy.
 *
 * When a session is in plan mode (status `planning` or `pending_approval`), every tool
 * that is not on the read-only allowlist is vetoed so the agent can only research and plan.
 * The agent must call `exit_plan_mode` (which rides PR-A's approval question) before any
 * mutation re-opens. This is a security boundary: unknown/new/plugin/MCP tools are blocked
 * by default; the allowlist + blocklist + suffix patterns + exec-prefix list + dangerous-flag
 * list are all part of the contract. Ported from the Smarter-Claw parity gate (156-case
 * harness) and adapted to this host's tool taxonomy (read/ls/grep/find/bash/exec/...).
 */

/** Tools explicitly allowed during plan mode (read / list / search / fetch / plan / meta). */
const PLAN_MODE_ALLOWED_TOOLS = new Set([
  // File + workspace reads
  "read",
  "ls",
  "grep",
  "find",
  "search",
  // Fetch
  "web_fetch",
  "web_search",
  // Memory reads (store variants are mutations and stay denied)
  "active_memory_search",
  // Plan lifecycle + user I/O
  "update_plan",
  "enter_plan_mode",
  "exit_plan_mode",
  "ask_user_question",
  // Read-only session/goal introspection
  "get_goal",
  "session_status",
  "sessions_list",
  "sessions_history",
  "sessions_yield",
  "agents_list",
  "transcripts",
  // NOTE: `sessions_spawn` / `subagents` are deliberately NOT allowlisted. A spawned child
  // runs in its own (non-plan) session, so its tools would bypass this gate — blocking the
  // spawn keeps plan mode a true read-only boundary.
]);

/**
 * Tools explicitly blocked during plan mode. Default-deny already blocks these, but the
 * explicit list documents intent and yields a specific deny message. `bash`/`exec` are here
 * yet handled by the read-only-command special case before the blocklist is consulted.
 */
const MUTATION_TOOL_BLOCKLIST = new Set([
  "apply_patch",
  "bash",
  "browser",
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
  "active_memory_store",
]);

/** Suffix patterns that mark a tool as mutating (catches MCP tools like `repo.write`). */
const MUTATION_SUFFIX_PATTERNS = [".write", ".edit", ".delete"];

/** Suffix patterns that mark a tool as read-only (lets MCP read tools through). */
const READONLY_SUFFIX_PATTERNS = [".read", ".search", ".list", ".get", ".view"];

/** Read-only exec/bash command prefixes allowed during plan mode. */
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

/** Flags that write files/execute even for read-only prefixes, so they block anyway. */
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

const EXEC_TOOL_NAMES = new Set(["exec", "bash"]);
const EXEC_COMMAND_PARAM_KEYS = ["command", "cmd"];

export type PlanModeGateResult = { blocked: false } | { blocked: true; reason: string };

function readExecCommand(params: unknown): string | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const record = params as Record<string, unknown>;
  for (const key of EXEC_COMMAND_PARAM_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function planModeBlock(reason: string): PlanModeGateResult {
  return { blocked: true, reason };
}

/**
 * Evaluate the plan-mode gate for one tool call. `planActive` is true when the session's
 * plan status is `planning` or `pending_approval`.
 */
export function checkPlanModeMutationGate(params: {
  toolName: string;
  planActive: boolean;
  toolParams?: unknown;
}): PlanModeGateResult {
  if (!params.planActive) {
    return { blocked: false };
  }
  const normalized = params.toolName.trim().toLowerCase();

  // Explicit allowlist always passes.
  if (PLAN_MODE_ALLOWED_TOOLS.has(normalized)) {
    return { blocked: false };
  }

  // exec/bash with a read-only command prefix is allowed, but shell operators and
  // dangerous flags reject first.
  if (EXEC_TOOL_NAMES.has(normalized)) {
    const execCommand = readExecCommand(params.toolParams);
    if (execCommand) {
      const cmd = execCommand.trim().toLowerCase();
      if (/[;|&`\n\r]|\$\(|>>?|<\(|>\(/.test(cmd)) {
        return planModeBlock(
          `Tool "${params.toolName}" command contains shell operators or newlines and is blocked in plan mode. Only simple read-only commands are allowed — present the plan via exit_plan_mode to execute.`,
        );
      }
      const hasDangerousFlag = DANGEROUS_FLAGS.some((flag) => {
        const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[\\s])${escaped}(?:[\\s=]|$)`, "i").test(cmd);
      });
      if (hasDangerousFlag) {
        return planModeBlock(
          `Tool "${params.toolName}" command contains a dangerous flag and is blocked in plan mode — present the plan via exit_plan_mode to execute.`,
        );
      }
      const isReadOnly = READ_ONLY_EXEC_PREFIXES.some(
        (prefix) => cmd === prefix || cmd.startsWith(`${prefix} `),
      );
      if (isReadOnly) {
        return { blocked: false };
      }
    }
  }

  // Explicit mutation blocklist.
  if (MUTATION_TOOL_BLOCKLIST.has(normalized)) {
    return planModeBlock(
      `Tool "${params.toolName}" is blocked in plan mode. Mutation tools stay blocked until the plan is approved — present the plan via exit_plan_mode to execute, or revise it with update_plan.`,
    );
  }

  // Mutation suffix patterns (MCP mutators such as custom.write / vault.delete).
  for (const suffix of MUTATION_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return planModeBlock(
        `Tool "${params.toolName}" matches mutation suffix "${suffix}" and is blocked in plan mode — present the plan via exit_plan_mode to execute.`,
      );
    }
  }

  // Read-only suffix patterns let MCP read tools through (custom.read / data.search).
  for (const suffix of READONLY_SUFFIX_PATTERNS) {
    if (normalized.endsWith(suffix)) {
      return { blocked: false };
    }
  }

  // Default deny: unknown/new/plugin/MCP tools are blocked so nothing bypasses the gate.
  return planModeBlock(
    `Tool "${params.toolName}" is not in the plan-mode read-only allowlist and is blocked by default — present the plan via exit_plan_mode to execute.`,
  );
}

/** Test/introspection view of the gate's contract lists. */
export const __planModeGateContract = {
  PLAN_MODE_ALLOWED_TOOLS: Array.from(PLAN_MODE_ALLOWED_TOOLS),
  MUTATION_TOOL_BLOCKLIST: Array.from(MUTATION_TOOL_BLOCKLIST),
  MUTATION_SUFFIX_PATTERNS,
  READONLY_SUFFIX_PATTERNS,
  READ_ONLY_EXEC_PREFIXES,
  DANGEROUS_FLAGS,
};
