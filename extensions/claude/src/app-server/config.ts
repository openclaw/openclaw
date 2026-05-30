/**
 * Strict configuration parsing for the Claude app-server bridge.
 *
 * Mirrors extensions/codex/src/app-server/config.ts at smaller scope.
 * Uses zod schemas so invalid plugin config is caught at boundary time
 * rather than surfacing as a runtime cast failure mid-turn.
 *
 * Responsibilities split between the bridge (this code) and the server:
 *   - command/args/env       → BRIDGE enforces (where to spawn the server).
 *   - turnTimeoutMs          → BRIDGE enforces (per-turn deadline timer).
 *   - turnIdleTimeoutMs      → BRIDGE enforces (notification idle watchdog).
 *   - approvalPolicy         → BRIDGE applies promotion (never → untrusted
 *                              when BeforeToolCall hooks exist); then
 *                              passed to server which makes the actual
 *                              approval gate decisions.
 *   - sandbox                → ECHOED to server (informational at the
 *                              bridge layer; the actual filesystem
 *                              sandbox is enforced via openclaw's
 *                              resolveSandboxContext earlier in the
 *                              turn — see run-attempt.ts).
 *   - dynamicTools.exclude   → BRIDGE enforces (filters openclaw tools
 *                              out of the projected DynamicToolSpec[]).
 */

import { z } from "zod";
import type { ApprovalPolicy, SandboxPolicy } from "./types.js";

export const DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY: ApprovalPolicy = "never";
export const DEFAULT_CLAUDE_APP_SERVER_SANDBOX: SandboxPolicy = { type: "dangerFullAccess" };
// Hard per-turn ceiling enforced via setTimeout(() => ac.abort(), …) at the
// top of run-attempt.ts. Independent of the heartbeat-protected idle
// watchdog (turnIdleTimeoutMs) below: heartbeats keep the idle timer alive
// during long Task subagent runs / bash steps, but this outer deadline
// fires regardless and tears the turn down. 10 minutes was too tight for
// agents that dispatch native Task subagents (Tank's PR-cluster work
// regularly exceeded that). 30 minutes matches codex's
// CODEX_TURN_TERMINAL_IDLE_TIMEOUT_MS (extensions/codex/src/app-server/
// attempt-timeouts.ts). Operators wanting longer or shorter caps can set
// pluginConfig.appServer.turnTimeoutMs explicitly.
export const DEFAULT_CLAUDE_APP_SERVER_TURN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_CLAUDE_APP_SERVER_TURN_IDLE_TIMEOUT_MS = 90_000;

// Bare bin name of the bridge. Used only as the placeholder command when no
// explicit override is set (commandSource "managed"); resolveManagedClaudeBridgeStartOptions
// replaces it with the absolute path of the bundled binary before spawn.
export const DEFAULT_CLAUDE_BRIDGE_COMMAND = "openclaw-claude-bridge";

// Env override for a custom bridge binary, mirroring codex's
// OPENCLAW_CODEX_APP_SERVER_BIN. Takes effect only when appServer.command is
// unset; a set appServer.command wins over the env.
export const CLAUDE_BRIDGE_BIN_ENV = "OPENCLAW_CLAUDE_APP_SERVER_BIN";

/**
 * Where the spawn command came from. "managed" => use the binary bundled in the
 * plugin's node_modules (the default, lockstep with the dependency pin);
 * "resolved-managed" => a managed lookup that has been resolved to an absolute
 * path; "config"/"env" => an explicit operator override (appServer.command or
 * the env var). Mirrors codex's CodexAppServerCommandSource.
 */
export type ClaudeBridgeCommandSource = "managed" | "resolved-managed" | "config" | "env";

export const CLAUDE_APP_SERVER_CONFIG_KEYS = [
  "command",
  "args",
  "env",
  "approvalPolicy",
  "sandbox",
  "turnTimeoutMs",
  "turnIdleTimeoutMs",
] as const;

export const CLAUDE_DYNAMIC_TOOLS_CONFIG_KEYS = ["exclude"] as const;

// ── zod schemas ─────────────────────────────────────────────────────────────

const approvalPolicySchema = z.enum(["never", "untrusted", "on-failure", "on-request"]);

const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);

// SandboxPolicy can arrive as either a short string ("workspace-write") OR a
// pre-structured object ({ type: "workspaceWrite", ... }). Normalize the
// string form into the object form so downstream code only deals with one
// shape.
const sandboxConfigSchema = z.union([
  sandboxModeSchema,
  z.object({ type: z.string() }).passthrough(),
]);

const positiveIntegerSchema = z.number().int().positive();

const appServerConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    approvalPolicy: approvalPolicySchema.optional(),
    sandbox: sandboxConfigSchema.optional(),
    turnTimeoutMs: positiveIntegerSchema.optional(),
    turnIdleTimeoutMs: positiveIntegerSchema.optional(),
  })
  .strict();

const dynamicToolsConfigSchema = z
  .object({
    exclude: z.array(z.string()).optional(),
  })
  .strict();

// ── public types ────────────────────────────────────────────────────────────

export type ClaudeAppServerRuntimeConfig = {
  /**
   * Resolved spawn command. For commandSource "managed" this is the bare bin
   * name placeholder (DEFAULT_CLAUDE_BRIDGE_COMMAND) until
   * resolveManagedClaudeBridgeStartOptions replaces it with the bundled binary's
   * absolute path; for "config"/"env" it is the operator's explicit override.
   */
  command: string;
  commandSource: ClaudeBridgeCommandSource;
  args?: string[];
  env?: Record<string, string>;
  approvalPolicy: ApprovalPolicy;
  sandbox: SandboxPolicy;
  turnTimeoutMs: number;
  turnIdleTimeoutMs: number;
};

export type ClaudeDynamicToolsRuntimeConfig = {
  excludeNames: string[];
};

export type ResolvedClaudeAppServerConfig = {
  appServer: ClaudeAppServerRuntimeConfig;
  dynamicTools: ClaudeDynamicToolsRuntimeConfig;
};

// ── resolver ────────────────────────────────────────────────────────────────

/**
 * Parse plugin config into a fully-resolved runtime config.
 *
 * Fail-closed semantics: if a section doesn't parse against its schema
 * (unknown keys, wrong types, malformed sandbox), fall back to runtime
 * defaults for that section rather than letting a partial cast leak into
 * the turn runner. Sections are parsed independently so partial
 * misconfiguration doesn't kill all defaults.
 */
export function resolveClaudeAppServerConfig(raw: unknown): ResolvedClaudeAppServerConfig {
  const root = asRecord(raw);
  const appServerParsed = appServerConfigSchema.safeParse(root.appServer ?? {});
  const dynamicToolsParsed = dynamicToolsConfigSchema.safeParse(root.dynamicTools ?? {});

  const parsed = appServerParsed.success ? appServerParsed.data : undefined;
  // Command precedence mirrors codex: explicit config > env override > managed
  // (bundled) binary. Only an explicit override sets a non-"managed" source;
  // "managed" is later resolved to the bundled absolute path before spawn.
  const configCommand = readNonEmptyString(parsed?.command);
  const envCommand = readNonEmptyString(process.env[CLAUDE_BRIDGE_BIN_ENV]);
  const command = configCommand ?? envCommand ?? DEFAULT_CLAUDE_BRIDGE_COMMAND;
  const commandSource: ClaudeBridgeCommandSource = configCommand
    ? "config"
    : envCommand
      ? "env"
      : "managed";

  const appServer: ClaudeAppServerRuntimeConfig = {
    command,
    commandSource,
    approvalPolicy: DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY,
    sandbox: DEFAULT_CLAUDE_APP_SERVER_SANDBOX,
    turnTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_TIMEOUT_MS,
    turnIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_IDLE_TIMEOUT_MS,
  };
  if (parsed) {
    if (parsed.args !== undefined) {
      appServer.args = parsed.args;
    }
    if (parsed.env !== undefined) {
      appServer.env = parsed.env;
    }
    if (parsed.approvalPolicy !== undefined) {
      appServer.approvalPolicy = parsed.approvalPolicy;
    }
    if (parsed.sandbox !== undefined) {
      appServer.sandbox = normalizeSandbox(parsed.sandbox);
    }
    if (parsed.turnTimeoutMs !== undefined) {
      appServer.turnTimeoutMs = parsed.turnTimeoutMs;
    }
    if (parsed.turnIdleTimeoutMs !== undefined) {
      appServer.turnIdleTimeoutMs = parsed.turnIdleTimeoutMs;
    }
  }

  const excludeNames =
    dynamicToolsParsed.success && dynamicToolsParsed.data.exclude !== undefined
      ? dynamicToolsParsed.data.exclude
      : [];

  return {
    appServer,
    dynamicTools: { excludeNames },
  };
}

export function normalizeClaudeAppServerApprovalPolicy(raw: unknown): ApprovalPolicy {
  const parsed = approvalPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY;
}

export function normalizeClaudeAppServerSandbox(raw: unknown): SandboxPolicy {
  const parsed = sandboxConfigSchema.safeParse(raw);
  return parsed.success ? normalizeSandbox(parsed.data) : DEFAULT_CLAUDE_APP_SERVER_SANDBOX;
}

// ── helpers ─────────────────────────────────────────────────────────────────

function normalizeSandbox(sandbox: z.infer<typeof sandboxConfigSchema>): SandboxPolicy {
  if (typeof sandbox === "string") {
    if (sandbox === "read-only") {
      return { type: "readOnly" };
    }
    if (sandbox === "workspace-write") {
      return { type: "workspaceWrite" };
    }
    return { type: "dangerFullAccess" };
  }
  return sandbox as SandboxPolicy;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
