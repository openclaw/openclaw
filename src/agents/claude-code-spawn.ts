import crypto from "node:crypto";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.js";
import { registerClaudeCodeRun, spawnClaudeCodeProcess } from "./claude-code-registry.js";
import { resolveClaudeCodeSession, getClaudeSessionId } from "./claude-code-sessions.js";
import { resolveCliBackendConfig } from "./cli-backends.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";

const log = createSubsystemLogger("claude-code-spawn");

export const CLAUDE_CODE_SPAWN_MODES = ["run", "session"] as const;
export type SpawnClaudeCodeMode = (typeof CLAUDE_CODE_SPAWN_MODES)[number];

export type SpawnClaudeCodeParams = {
  task: string;
  label?: string;
  cwd?: string;
  mode?: SpawnClaudeCodeMode;
  resume?: boolean;
  timeoutSeconds?: number;
};

export type SpawnClaudeCodeContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  sandboxed?: boolean;
};

export type SpawnClaudeCodeResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnClaudeCodeMode;
  note?: string;
  error?: string;
};

export const CLAUDE_CODE_SPAWN_ACCEPTED_NOTE =
  "Claude Code task queued in isolated workspace session; results will be announced when complete.";

export function resolveClaudeCodeSpawnPolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
}): string | undefined {
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  if (requesterSandboxed) {
    return 'Sandboxed sessions cannot spawn Claude Code sessions because runtime="claude-code" runs on the host. Use runtime="subagent" from sandboxed sessions.';
  }
  return undefined;
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnClaudeCodeMode;
  resumeRequested: boolean;
}): SpawnClaudeCodeMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Resume should default to session mode
  return params.resumeRequested ? "session" : "run";
}

export async function spawnClaudeCodeDirect(
  params: SpawnClaudeCodeParams,
  ctx: SpawnClaudeCodeContext,
): Promise<SpawnClaudeCodeResult> {
  const cfg = loadConfig();

  const parentSessionKey = ctx.agentSessionKey?.trim();

  const runtimePolicyError = resolveClaudeCodeSpawnPolicyError({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
    requesterSandboxed: ctx.sandboxed,
  });
  if (runtimePolicyError) {
    return {
      status: "forbidden",
      error: runtimePolicyError,
    };
  }

  const resumeRequested = params.resume === true;
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    resumeRequested,
  });

  // Resolve workspace path
  const cwd = params.cwd?.trim() || process.cwd();

  // Resolve or create session for workspace
  const { sessionKey, isNew } = resolveClaudeCodeSession({
    workspacePath: cwd,
    resume: resumeRequested || spawnMode === "session",
  });

  // Get backend configuration
  const backend = resolveCliBackendConfig("claude-code", cfg);
  if (!backend) {
    return {
      status: "error",
      error: "Failed to resolve claude-code backend configuration.",
    };
  }

  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    threadId: ctx.agentThreadId,
  });

  // Generate run ID
  const runId = crypto.randomUUID();

  // Register the run
  registerClaudeCodeRun({
    runId,
    sessionKey,
    workspacePath: cwd,
    task: params.task,
    requesterSessionKey: parentSessionKey,
    requesterOrigin,
    label: params.label,
    cleanup: spawnMode === "run" ? "delete" : "keep",
  });

  // Build CLI arguments
  // Check for existing Claude session ID to resume conversation
  const existingClaudeSessionId = getClaudeSessionId(cwd);
  const shouldResume = existingClaudeSessionId && (resumeRequested || spawnMode === "session");

  log.debug(
    `spawnClaudeCodeDirect: workspace=${cwd}, resumeRequested=${resumeRequested}, spawnMode=${spawnMode}, existingClaudeSessionId=${existingClaudeSessionId ?? "none"}`,
  );

  let cliArgs: string[];
  if (shouldResume && backend.config.resumeArgs) {
    // Use resumeArgs with --resume for continuing existing session
    cliArgs = backend.config.resumeArgs.map((arg) =>
      arg === "{sessionId}" ? existingClaudeSessionId : arg,
    );
    log.info(
      `spawnClaudeCodeDirect: resuming Claude session with --resume ${existingClaudeSessionId}`,
    );
  } else {
    // Use regular args for new session
    cliArgs = [...(backend.config.args ?? [])];
    log.debug(`spawnClaudeCodeDirect: starting fresh Claude session (no --resume)`);
  }

  // Add task as the last argument
  cliArgs.push(params.task);

  // Build environment
  const env: Record<string, string> = {};
  for (const key of backend.config.clearEnv ?? []) {
    env[key] = "";
  }
  for (const [key, value] of Object.entries(backend.config.env ?? {})) {
    env[key] = value;
  }

  // Calculate timeout
  const timeoutMs = params.timeoutSeconds ? params.timeoutSeconds * 1000 : undefined;

  // Spawn the process
  spawnClaudeCodeProcess({
    runId,
    command: backend.config.command,
    args: cliArgs,
    cwd,
    env,
    timeoutMs,
  });

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId,
    mode: spawnMode,
    note: isNew
      ? CLAUDE_CODE_SPAWN_ACCEPTED_NOTE
      : "Claude Code task queued in existing workspace session; results will be announced when complete.",
  };
}
