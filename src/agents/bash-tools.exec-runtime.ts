import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  resolveExecApprovalAllowedDecisions,
  type ExecHost,
  type ExecApprovalDecision,
  type ExecTarget,
} from "../infra/exec-approvals.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { isDangerousHostEnvVarName } from "../infra/host-env-security.js";
import { findPathKey, mergePathPrepend } from "../infra/path-prepend.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { scopedHeartbeatWakeOptions } from "../routing/session-key.js";
import type { ProcessSession } from "./bash-process-registry.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
export { applyPathPrepend, findPathKey, normalizePathPrepend } from "../infra/path-prepend.js";
export {
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecSecurity,
  normalizeExecTarget,
} from "../infra/exec-approvals.js";
import { logWarn } from "../logger.js";
import type { ManagedRun } from "../process/supervisor/index.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { RunExit, TerminationReason } from "../process/supervisor/types.js";
import {
  addSession,
  appendOutput,
  createSessionSlug,
  deleteSession,
  markExited,
  tail,
} from "./bash-process-registry.js";
import {
  buildDockerExecArgs,
  chunkString,
  clampWithDefault,
  readEnvInt,
} from "./bash-tools.shared.js";
import { buildCursorPositionResponse, stripDsrRequests } from "./pty-dsr.js";
import { getShellConfig, sanitizeBinaryOutput } from "./shell-utils.js";

const SMKX = "\x1b[?1h";
const RMKX = "\x1b[?1l";

let taskExecutorModulePromise: Promise<typeof import("../tasks/task-executor.js")> | null = null;

async function loadTaskExecutorModule() {
  taskExecutorModulePromise ??= import("../tasks/task-executor.js");
  return await taskExecutorModulePromise;
}

/**
 * Detect cursor key mode from PTY output chunk.
 * Uses lastIndexOf to find the *last* toggle in the chunk.
 * Returns "application" if smkx is the last toggle, "normal" if rmkx is last,
 * or null if no toggle is found.
 */
export function detectCursorKeyMode(raw: string): "application" | "normal" | null {
  const lastSmkx = raw.lastIndexOf(SMKX);
  const lastRmkx = raw.lastIndexOf(RMKX);
  if (lastSmkx === -1 && lastRmkx === -1) {
    return null;
  }
  // Whichever appears later in the chunk wins.
  return lastSmkx > lastRmkx ? "application" : "normal";
}

// Sanitize inherited host env before merge so dangerous variables from process.env
// are not propagated into non-sandboxed executions.
export function sanitizeHostBaseEnv(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (upperKey === "PATH") {
      sanitized[key] = value;
      continue;
    }
    if (isDangerousHostEnvVarName(upperKey)) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}
// Centralized sanitization helper.
// Throws an error if dangerous variables or PATH modifications are detected on the host.
export function validateHostEnv(env: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    const upperKey = key.toUpperCase();

    // 1. Block known dangerous variables (Fail Closed)
    if (isDangerousHostEnvVarName(upperKey)) {
      throw new Error(
        `Security Violation: Environment variable '${key}' is forbidden during host execution.`,
      );
    }

    // 2. Strictly block PATH modification on host
    // Allowing custom PATH on the gateway/node can lead to binary hijacking.
    if (upperKey === "PATH") {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
  }
}
export const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  200_000,
);
export const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_NOTIFY_TAIL_CHARS = 400;
const DEFAULT_NOTIFY_SNIPPET_CHARS = 180;
export const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 10_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

export const execSchema = Type.Object({
  command: Type.String({ description: "Shell command to execute" }),
  workdir: Type.Optional(Type.String({ description: "Working directory (defaults to cwd)" })),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
  yieldMs: Type.Optional(
    Type.Number({
      description: "Milliseconds to wait before backgrounding (default 10000)",
    }),
  ),
  background: Type.Optional(Type.Boolean({ description: "Run in background immediately" })),
  timeout: Type.Optional(
    Type.Number({
      description: "Timeout in seconds (optional, kills process on expiry)",
    }),
  ),
  pty: Type.Optional(
    Type.Boolean({
      description:
        "Run in a pseudo-terminal (PTY) when available (TTY-required CLIs, coding agents)",
    }),
  ),
  elevated: Type.Optional(
    Type.Boolean({
      description: "Run on the host with elevated permissions (if allowed)",
    }),
  ),
  host: Type.Optional(
    Type.String({
      description: "Exec host/target (auto|sandbox|gateway|node).",
    }),
  ),
  security: Type.Optional(
    Type.String({
      description: "Exec security mode (deny|allowlist|full).",
    }),
  ),
  ask: Type.Optional(
    Type.String({
      description: "Exec ask mode (off|on-miss|always).",
    }),
  ),
  node: Type.Optional(
    Type.String({
      description: "Node id/name for host=node.",
    }),
  ),
});

export type ExecProcessFailureKind =
  | "shell-command-not-found"
  | "shell-not-executable"
  | "overall-timeout"
  | "no-output-timeout"
  | "signal"
  | "aborted"
  | "runtime-error";

type ExecExitFailureKind = Exclude<ExecProcessFailureKind, "runtime-error">;

export type ExecProcessOutcome =
  | {
      status: "completed";
      exitCode: number;
      exitSignal: NodeJS.Signals | number | null;
      durationMs: number;
      aggregated: string;
      timedOut: false;
    }
  | {
      status: "failed";
      exitCode: number | null;
      exitSignal: NodeJS.Signals | number | null;
      durationMs: number;
      aggregated: string;
      timedOut: boolean;
      failureKind: ExecProcessFailureKind;
      reason: string;
    };

export type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
};

export function renderExecHostLabel(host: ExecHost) {
  return host === "sandbox" ? "sandbox" : host === "gateway" ? "gateway" : "node";
}

export function renderExecTargetLabel(target: ExecTarget) {
  return target === "auto" ? "auto" : renderExecHostLabel(target);
}

export function isRequestedExecTargetAllowed(params: {
  configuredTarget: ExecTarget;
  requestedTarget: ExecTarget;
}) {
  // `auto` is a routing strategy, not a wildcard allowlist. Keep per-call host
  // selection pinned to the configured/session-selected target so a sandboxed
  // session cannot silently hop to gateway or node.
  return params.requestedTarget === params.configuredTarget;
}

export function resolveExecTarget(params: {
  configuredTarget?: ExecTarget;
  requestedTarget?: ExecTarget | null;
  elevatedRequested: boolean;
  sandboxAvailable: boolean;
}) {
  const configuredTarget = params.configuredTarget ?? "auto";
  const requestedTarget = params.requestedTarget ?? null;
  if (params.elevatedRequested) {
    return {
      configuredTarget,
      requestedTarget,
      selectedTarget: "gateway" as const,
      effectiveHost: "gateway" as const,
    };
  }
  if (
    requestedTarget &&
    !isRequestedExecTargetAllowed({
      configuredTarget,
      requestedTarget,
    })
  ) {
    throw new Error(
      `exec host not allowed (requested ${renderExecTargetLabel(requestedTarget)}; ` +
        `configure tools.exec.host=${renderExecTargetLabel(requestedTarget)} to allow).`,
    );
  }
  const selectedTarget = requestedTarget ?? configuredTarget;
  // `auto` preserves the no-config "just work" default: sandbox when available,
  // otherwise gateway. The YOLO part comes from security/ask defaults, not from
  // `auto` itself.
  const effectiveHost =
    selectedTarget === "auto" ? (params.sandboxAvailable ? "sandbox" : "gateway") : selectedTarget;
  return {
    configuredTarget,
    requestedTarget,
    selectedTarget,
    effectiveHost,
  };
}

export function normalizeNotifyOutput(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactNotifyOutput(value: string, maxChars = DEFAULT_NOTIFY_SNIPPET_CHARS) {
  const normalized = normalizeNotifyOutput(value);
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }
  const safe = Math.max(1, maxChars - 1);
  return `${normalized.slice(0, safe)}…`;
}

export function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  const entries = shellPath
    .split(path.delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return;
  }
  const pathKey = findPathKey(env);
  const merged = mergePathPrepend(env[pathKey], entries);
  if (merged) {
    env[pathKey] = merged;
  }
}

function maybeNotifyOnExit(session: ProcessSession, status: "completed" | "failed" | "killed") {
  if (
    !session.backgrounded ||
    !session.notifyOnExit ||
    session.exitNotified ||
    session.removed === true ||
    session.removeOnExit === true
  ) {
    return;
  }
  const sessionKey = session.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  session.exitNotified = true;
  const exitLabel = session.exitSignal
    ? `signal ${session.exitSignal}`
    : `code ${session.exitCode ?? 0}`;
  const output = compactNotifyOutput(
    tail(session.tail || session.aggregated || "", DEFAULT_NOTIFY_TAIL_CHARS),
  );
  if (status === "completed" && !output && session.notifyOnExitEmptySuccess !== true) {
    return;
  }
  const notifyStatus = status === "killed" ? "cancelled" : status;
  const summary = output
    ? `Exec ${notifyStatus} (${session.id.slice(0, 8)}, ${exitLabel}) :: ${output}`
    : `Exec ${notifyStatus} (${session.id.slice(0, 8)}, ${exitLabel})`;
  enqueueSystemEvent(summary, { sessionKey });
  requestHeartbeatNow(
    scopedHeartbeatWakeOptions(sessionKey, { reason: `exec:${session.id}:exit` }),
  );
}

export function notifyExecSessionExit(
  session: ProcessSession,
  status: "completed" | "failed" | "killed",
) {
  maybeNotifyOnExit(session, status);
}

export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  allowedDecisions?: readonly ExecApprovalDecision[];
  command: string;
  cwd: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
}) {
  let fence = "```";
  while (params.command.includes(fence)) {
    fence += "`";
  }
  const commandBlock = `${fence}sh\n${params.command}\n${fence}`;
  const lines: string[] = [];
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  const decisionText = allowedDecisions.join("|");
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
  lines.push(`Host: ${params.host}`);
  if (params.nodeId) {
    lines.push(`Node: ${params.nodeId}`);
  }
  lines.push(`CWD: ${params.cwd ?? "(node default)"}`);
  lines.push("Command:");
  lines.push(commandBlock);
  lines.push("Mode: foreground (interactive approvals available).");
  lines.push(
    allowedDecisions.includes("allow-always")
      ? "Background mode requires pre-approved policy (allow-always or ask=off)."
      : "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
  );
  lines.push(`Reply with: /approve ${params.approvalSlug} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push(
      "The effective approval policy requires approval every time, so Allow Always is unavailable.",
    );
  }
  lines.push("If the short code is ambiguous, use the full id in /approve.");
  return lines.join("\n");
}

export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

export function emitExecSystemEvent(
  text: string,
  opts: { sessionKey?: string; contextKey?: string },
) {
  const sessionKey = opts.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  enqueueSystemEvent(text, { sessionKey, contextKey: opts.contextKey });
  requestHeartbeatNow(scopedHeartbeatWakeOptions(sessionKey, { reason: "exec-event" }));
}

function joinExecFailureOutput(aggregated: string, reason: string) {
  return aggregated ? `${aggregated}\n\n${reason}` : reason;
}

function classifyExecFailureKind(params: {
  exitReason: TerminationReason;
  exitCode: number;
  isShellFailure: boolean;
  exitSignal: NodeJS.Signals | number | null;
}): ExecExitFailureKind {
  if (params.isShellFailure) {
    return params.exitCode === 127 ? "shell-command-not-found" : "shell-not-executable";
  }
  if (params.exitReason === "overall-timeout") {
    return "overall-timeout";
  }
  if (params.exitReason === "no-output-timeout") {
    return "no-output-timeout";
  }
  if (params.exitSignal != null) {
    return "signal";
  }
  return "aborted";
}

export function formatExecFailureReason(params: {
  failureKind: ExecExitFailureKind;
  exitSignal: NodeJS.Signals | number | null;
  timeoutSec: number | null | undefined;
}): string {
  switch (params.failureKind) {
    case "shell-command-not-found":
      return "Command not found";
    case "shell-not-executable":
      return "Command not executable (permission denied)";
    case "overall-timeout":
      return typeof params.timeoutSec === "number" && params.timeoutSec > 0
        ? `Command timed out after ${params.timeoutSec} seconds. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).`
        : "Command timed out. If this command is expected to take longer, re-run with a higher timeout (e.g., exec timeout=300).";
    case "no-output-timeout":
      return "Command timed out waiting for output";
    case "signal":
      return `Command aborted by signal ${params.exitSignal}`;
    case "aborted":
      return "Command aborted before exit code was captured";
  }
}

export function buildExecExitOutcome(params: {
  exit: RunExit;
  aggregated: string;
  durationMs: number;
  timeoutSec: number | null | undefined;
}): ExecProcessOutcome {
  const exitCode = params.exit.exitCode ?? 0;
  const isNormalExit = params.exit.reason === "exit";
  const isShellFailure = exitCode === 126 || exitCode === 127;
  const status: ExecProcessOutcome["status"] =
    isNormalExit && !isShellFailure ? "completed" : "failed";
  if (status === "completed") {
    const exitMsg = exitCode !== 0 ? `\n\n(Command exited with code ${exitCode})` : "";
    return {
      status: "completed",
      exitCode,
      exitSignal: params.exit.exitSignal,
      durationMs: params.durationMs,
      aggregated: params.aggregated + exitMsg,
      timedOut: false,
    };
  }
  const failureKind = classifyExecFailureKind({
    exitReason: params.exit.reason,
    exitCode,
    isShellFailure,
    exitSignal: params.exit.exitSignal,
  });
  const reason = formatExecFailureReason({
    failureKind,
    exitSignal: params.exit.exitSignal,
    timeoutSec: params.timeoutSec,
  });
  return {
    status: "failed",
    exitCode: params.exit.exitCode,
    exitSignal: params.exit.exitSignal,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: params.exit.timedOut,
    failureKind,
    reason: joinExecFailureOutput(params.aggregated, reason),
  };
}

export function buildExecRuntimeErrorOutcome(params: {
  error: unknown;
  aggregated: string;
  durationMs: number;
}): ExecProcessOutcome {
  return {
    status: "failed",
    exitCode: null,
    exitSignal: null,
    durationMs: params.durationMs,
    aggregated: params.aggregated,
    timedOut: false,
    failureKind: "runtime-error",
    reason: joinExecFailureOutput(params.aggregated, String(params.error)),
  };
}

const CLI_TASK_NO_OUTPUT_STALL_MS = 120_000;

function shouldAcceptCliTaskUpdates(session: ProcessSession) {
  return !session.cancelRequestedByUser && !session.removed && !session.exited;
}

export function armCliTaskNoOutputNotice(session: ProcessSession) {
  if (session.stallTimer) {
    clearTimeout(session.stallTimer);
    session.stallTimer = null;
  }
  if (
    !session.backgrounded ||
    !session.cliTaskCreated ||
    !shouldAcceptCliTaskUpdates(session) ||
    session.stallNotified
  ) {
    return;
  }

  const lastOutputAt = session.lastOutputAt ?? session.startedAt;
  const elapsedMs = Math.max(0, Date.now() - lastOutputAt);
  const delayMs = Math.max(0, CLI_TASK_NO_OUTPUT_STALL_MS - elapsedMs);

  session.stallTimer = setTimeout(() => {
    if (
      !session.backgrounded ||
      !session.cliTaskCreated ||
      !shouldAcceptCliTaskUpdates(session) ||
      session.stallNotified
    ) {
      session.stallTimer = null;
      return;
    }
    const now = Date.now();
    const latestOutputAt = session.lastOutputAt ?? session.startedAt;
    if (now - latestOutputAt < CLI_TASK_NO_OUTPUT_STALL_MS) {
      armCliTaskNoOutputNotice(session);
      return;
    }

    session.stallNotified = true;
    session.lastTaskUpdateAt = now;
    session.stallTimer = null;
    void loadTaskExecutorModule()
      .then(({ recordTaskRunProgressByRunId }) => {
        if (!shouldAcceptCliTaskUpdates(session) || session.stallNotified !== true) {
          return;
        }
        recordTaskRunProgressByRunId({
          runId: session.id,
          runtime: "cli",
          lastEventAt: now,
          progressSummary: "No output for 120s.",
        });
      })
      .catch((error) => {
        logWarn(`exec: failed to record CLI stall notice for ${session.id}: ${String(error)}`);
      });
  }, delayMs);
  session.stallTimer.unref?.();
}

export async function runExecProcess(opts: {
  command: string;
  // Execute this instead of `command` (which is kept for display/session/logging).
  // Used to sanitize safeBins execution while preserving the original user input.
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  notifyOnExit: boolean;
  notifyOnExitEmptySuccess?: boolean;
  scopeKey?: string;
  sessionKey?: string;
  timeoutSec: number | null;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
}): Promise<ExecProcessHandle> {
  const startedAt = Date.now();
  const sessionId = createSessionSlug();
  const execCommand = opts.execCommand ?? opts.command;
  const supervisor = getProcessSupervisor();
  const shellRuntimeEnv: Record<string, string> = {
    ...opts.env,
    OPENCLAW_SHELL: "exec",
  };

  const session: ProcessSession = {
    id: sessionId,
    command: opts.command,
    scopeKey: opts.scopeKey,
    sessionKey: opts.sessionKey,
    notifyOnExit: opts.notifyOnExit,
    notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
    exitNotified: false,
    child: undefined,
    stdin: undefined,
    pid: undefined,
    startedAt,
    cwd: opts.workdir,
    maxOutputChars: opts.maxOutput,
    pendingMaxOutputChars: opts.pendingMaxOutput,
    totalOutputChars: 0,
    pendingStdout: [],
    pendingStderr: [],
    pendingStdoutChars: 0,
    pendingStderrChars: 0,
    aggregated: "",
    tail: "",
    lastOutputAt: undefined,
    exited: false,
    exitCode: undefined as number | null | undefined,
    exitSignal: undefined as NodeJS.Signals | number | null | undefined,
    truncated: false,
    backgrounded: false,
    cliTaskCreated: false,
    cliTaskCreationPromise: null,
    taskOutputSeen: false,
    lastTaskUpdateAt: undefined,
    stallNotified: false,
    cancelRequestedByUser: false,
    removeOnExit: false,
    removed: false,
    stallTimer: null,
    cursorKeyMode: opts.usePty ? "unknown" : "normal",
  };
  addSession(session);

  const reportCliTaskProgress = (summary?: string) => {
    if (
      !session.cliTaskCreated ||
      !session.backgrounded ||
      !shouldAcceptCliTaskUpdates(session)
    ) {
      return;
    }
    if (summary) {
      const now = Date.now();
      session.lastTaskUpdateAt = now;
      void loadTaskExecutorModule()
        .then(({ recordTaskRunProgressByRunId }) => {
          if (!shouldAcceptCliTaskUpdates(session)) {
            return;
          }
          recordTaskRunProgressByRunId({
            runId: session.id,
            runtime: "cli",
            lastEventAt: now,
            progressSummary: summary,
          });
        })
        .catch((error) => {
          logWarn(`exec: failed to record CLI task progress for ${session.id}: ${String(error)}`);
        });
    }
    session.stallNotified = false;
    session.taskOutputSeen = true;
    armCliTaskNoOutputNotice(session);
  };

  const emitUpdate = () => {
    if (!opts.onUpdate) {
      return;
    }
    const tailText = session.tail || session.aggregated;
    const warningText = opts.warnings.length ? `${opts.warnings.join("\n")}\n\n` : "";
    opts.onUpdate({
      content: [{ type: "text", text: warningText + (tailText || "") }],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: session.tail,
      },
    });
  };

  const handleStdout = (data: string) => {
    const raw = data.toString();
    // Detect smkx/rmkx BEFORE sanitizeBinaryOutput strips ESC sequences.
    // Note: PTY chunking is arbitrary, but smkx/rmkx sequences are typically short (4-5 bytes)
    // and sent atomically by terminals. Split across chunks is rare in practice.
    const mode = detectCursorKeyMode(raw);
    if (mode) {
      session.cursorKeyMode = mode;
    }
    const str = sanitizeBinaryOutput(raw);
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stdout", chunk);
      emitUpdate();
      if (chunk.length > 0) {
        reportCliTaskProgress(
          session.taskOutputSeen
            ? session.stallNotified
              ? "Resumed output."
              : undefined
            : "Output received.",
        );
      }
    }
  };

  const handleStderr = (data: string) => {
    const str = sanitizeBinaryOutput(data.toString());
    for (const chunk of chunkString(str)) {
      appendOutput(session, "stderr", chunk);
      emitUpdate();
      if (chunk.length > 0) {
        reportCliTaskProgress(
          session.taskOutputSeen
            ? session.stallNotified
              ? "Resumed output."
              : undefined
            : "Output received.",
        );
      }
    }
  };

  const timeoutMs =
    typeof opts.timeoutSec === "number" && opts.timeoutSec > 0
      ? Math.floor(opts.timeoutSec * 1000)
      : undefined;
  let sandboxFinalizeToken: unknown;

  const spawnSpec:
    | {
        mode: "child";
        argv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open" | "pipe-closed";
      }
    | {
        mode: "pty";
        ptyCommand: string;
        childFallbackArgv: string[];
        env: NodeJS.ProcessEnv;
        stdinMode: "pipe-open";
      } = await (async () => {
    if (opts.sandbox) {
      const backendExecSpec = await opts.sandbox.buildExecSpec?.({
        command: execCommand,
        workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
        env: shellRuntimeEnv,
        usePty: opts.usePty,
      });
      sandboxFinalizeToken = backendExecSpec?.finalizeToken;
      return {
        mode: "child" as const,
        argv: backendExecSpec?.argv ?? [
          "docker",
          ...buildDockerExecArgs({
            containerName: opts.sandbox.containerName,
            command: execCommand,
            workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
            env: shellRuntimeEnv,
            tty: opts.usePty,
          }),
        ],
        env: backendExecSpec?.env ?? process.env,
        stdinMode:
          backendExecSpec?.stdinMode ??
          (opts.usePty ? ("pipe-open" as const) : ("pipe-closed" as const)),
      };
    }
    const { shell, args: shellArgs } = getShellConfig();
    const childArgv = [shell, ...shellArgs, execCommand];
    if (opts.usePty) {
      return {
        mode: "pty" as const,
        ptyCommand: execCommand,
        childFallbackArgv: childArgv,
        env: shellRuntimeEnv,
        stdinMode: "pipe-open" as const,
      };
    }
    return {
      mode: "child" as const,
      argv: childArgv,
      env: shellRuntimeEnv,
      stdinMode: "pipe-closed" as const,
    };
  })();

  let managedRun: ManagedRun | null = null;
  let usingPty = spawnSpec.mode === "pty";
  const cursorResponse = buildCursorPositionResponse();

  const onSupervisorStdout = (chunk: string) => {
    if (usingPty) {
      const { cleaned, requests } = stripDsrRequests(chunk);
      if (requests > 0 && managedRun?.stdin) {
        for (let i = 0; i < requests; i += 1) {
          managedRun.stdin.write(cursorResponse);
        }
      }
      handleStdout(cleaned);
      return;
    }
    handleStdout(chunk);
  };

  try {
    const spawnBase = {
      runId: sessionId,
      sessionId: opts.sessionKey?.trim() || sessionId,
      backendId: opts.sandbox ? "exec-sandbox" : "exec-host",
      scopeKey: opts.scopeKey,
      cwd: opts.workdir,
      env: spawnSpec.env,
      timeoutMs,
      captureOutput: false,
      onStdout: onSupervisorStdout,
      onStderr: handleStderr,
    };
    managedRun =
      spawnSpec.mode === "pty"
        ? await supervisor.spawn({
            ...spawnBase,
            mode: "pty",
            ptyCommand: spawnSpec.ptyCommand,
          })
        : await supervisor.spawn({
            ...spawnBase,
            mode: "child",
            argv: spawnSpec.argv,
            stdinMode: spawnSpec.stdinMode,
          });
  } catch (err) {
    if (spawnSpec.mode === "pty") {
      const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
      logWarn(
        `exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`,
      );
      opts.warnings.push(warning);
      usingPty = false;
      try {
        managedRun = await supervisor.spawn({
          runId: sessionId,
          sessionId: opts.sessionKey?.trim() || sessionId,
          backendId: "exec-host",
          scopeKey: opts.scopeKey,
          mode: "child",
          argv: spawnSpec.childFallbackArgv,
          cwd: opts.workdir,
          env: spawnSpec.env,
          stdinMode: "pipe-open",
          timeoutMs,
          captureOutput: false,
          onStdout: handleStdout,
          onStderr: handleStderr,
        });
      } catch (retryErr) {
        const now = Date.now();
        markExited(session, null, null, "failed");
        maybeNotifyOnExit(session, "failed");
        if (session.cliTaskCreated) {
          try {
            const { failTaskRunByRunId } = await loadTaskExecutorModule();
            failTaskRunByRunId({
              runId: session.id,
              runtime: "cli",
              status: "failed",
              endedAt: now,
              lastEventAt: now,
              error: `Command spawn failed: ${String(retryErr)}`,
              terminalSummary: "Command spawn failed.",
            });
          } catch (taskError) {
            logWarn(`exec: failed to record CLI spawn failure for ${session.id}: ${String(taskError)}`);
          }
        }
        throw retryErr;
      }
    } else {
      const now = Date.now();
      markExited(session, null, null, "failed");
      maybeNotifyOnExit(session, "failed");
      if (session.cliTaskCreated) {
        try {
          const { failTaskRunByRunId } = await loadTaskExecutorModule();
          failTaskRunByRunId({
            runId: session.id,
            runtime: "cli",
            status: "failed",
            endedAt: now,
            lastEventAt: now,
            error: `Command spawn failed: ${String(err)}`,
            terminalSummary: "Command spawn failed.",
          });
        } catch (taskError) {
          logWarn(`exec: failed to record CLI spawn failure for ${session.id}: ${String(taskError)}`);
        }
      }
      throw err;
    }
  }
  session.stdin = managedRun.stdin;
  session.pid = managedRun.pid;

  const promise = managedRun
    .wait()
    .then(async (exit): Promise<ExecProcessOutcome> => {
      const durationMs = Date.now() - startedAt;
      const outcome = buildExecExitOutcome({
        exit,
        aggregated: session.aggregated.trim(),
        durationMs,
        timeoutSec: opts.timeoutSec,
      });

      if (session.cliTaskCreationPromise) {
        await session.cliTaskCreationPromise;
      }

      const now = Date.now();
      const cancelledByUser = session.cancelRequestedByUser === true;

      if (session.cliTaskCreated) {
        if (!cancelledByUser && outcome.status === "completed") {
          try {
            const { completeTaskRunByRunId } = await loadTaskExecutorModule();
            completeTaskRunByRunId({
              runId: session.id,
              runtime: "cli",
              endedAt: now,
              lastEventAt: now,
              terminalSummary: "Completed.",
            });
          } catch (taskError) {
            logWarn(`exec: failed to record CLI completion for ${session.id}: ${String(taskError)}`);
          }
        } else {
          const terminalStatus = cancelledByUser ? "cancelled" : exit.timedOut ? "timed_out" : "failed";
          const terminalError =
            outcome.status === "failed"
              ? outcome.reason
              : cancelledByUser
                ? "Command cancelled by user."
                : undefined;
          try {
            const { failTaskRunByRunId } = await loadTaskExecutorModule();
            failTaskRunByRunId({
              runId: session.id,
              runtime: "cli",
              status: terminalStatus,
              endedAt: now,
              lastEventAt: now,
              error: terminalError,
              terminalSummary:
                terminalStatus === "cancelled"
                  ? "Terminated by user."
                  : terminalStatus === "timed_out"
                    ? "Timed out."
                    : "Failed.",
            });
          } catch (taskError) {
            logWarn(`exec: failed to record CLI terminal state for ${session.id}: ${String(taskError)}`);
          }
        }
      }

      if (session.stallTimer) {
        clearTimeout(session.stallTimer);
        session.stallTimer = null;
      }

      markExited(
        session,
        exit.exitCode,
        exit.exitSignal,
        cancelledByUser ? "killed" : outcome.status,
      );
      maybeNotifyOnExit(session, cancelledByUser ? "killed" : outcome.status);
      if (!session.child && session.stdin) {
        session.stdin.destroyed = true;
      }
      if (opts.sandbox?.finalizeExec) {
        await opts.sandbox.finalizeExec({
          status: outcome.status,
          exitCode: exit.exitCode ?? null,
          timedOut: exit.timedOut,
          token: sandboxFinalizeToken,
        });
      }
      if (session.removeOnExit) {
        session.removed = true;
        deleteSession(session.id);
      }
      return outcome;
    })
    .catch(async (err): Promise<ExecProcessOutcome> => {
      if (session.cliTaskCreationPromise) {
        await session.cliTaskCreationPromise;
      }
      const now = Date.now();
      if (session.stallTimer) {
        clearTimeout(session.stallTimer);
        session.stallTimer = null;
      }
      if (session.cliTaskCreated) {
        try {
          const { failTaskRunByRunId } = await loadTaskExecutorModule();
          failTaskRunByRunId({
            runId: session.id,
            runtime: "cli",
            status: session.cancelRequestedByUser ? "cancelled" : "failed",
            endedAt: now,
            lastEventAt: now,
            error: String(err),
            terminalSummary: session.cancelRequestedByUser ? "Terminated by user." : "Failed.",
          });
        } catch (taskError) {
          logWarn(`exec: failed to record CLI runtime failure for ${session.id}: ${String(taskError)}`);
        }
      }
      markExited(session, null, null, session.cancelRequestedByUser ? "killed" : "failed");
      maybeNotifyOnExit(session, session.cancelRequestedByUser ? "killed" : "failed");
      if (session.removeOnExit) {
        session.removed = true;
        deleteSession(session.id);
      }
      return buildExecRuntimeErrorOutcome({
        error: err,
        aggregated: session.aggregated.trim(),
        durationMs: now - startedAt,
      });
    });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => {
      managedRun?.cancel("manual-cancel");
    },
  };
}
