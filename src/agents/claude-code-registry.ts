import { spawn, type ChildProcess } from "node:child_process";
import { emitAgentEvent } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
import { updateClaudeSessionId } from "./claude-code-sessions.js";
import { runSubagentAnnounceFlow, type SubagentRunOutcome } from "./subagent-announce.js";

const log = createSubsystemLogger("claude-code-registry");

/**
 * Parse Claude CLI JSON output to extract session_id.
 * Claude CLI outputs a single JSON object per invocation.
 * Supports multiple session ID field names for compatibility.
 */
const SESSION_ID_FIELDS = ["session_id", "sessionId", "conversation_id", "conversationId"] as const;

export function parseClaudeOutput(output: string): { session_id?: string } | null {
  const trimmed = output.trim();
  if (!trimmed) {
    log.debug("parseClaudeOutput: empty output");
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    // Check all possible session ID fields
    for (const field of SESSION_ID_FIELDS) {
      const value = parsed[field];
      if (typeof value === "string" && value) {
        log.debug(`parseClaudeOutput: found session ID in field "${field}": ${value}`);
        return { session_id: value };
      }
    }
    log.debug(`parseClaudeOutput: no session ID found in fields: ${SESSION_ID_FIELDS.join(", ")}`);
    return null;
  } catch (parseError) {
    // Output might contain multiple lines or non-JSON
    // Try to find JSON objects line by line (handles multi-JSON output like: {"type":"text"} {"session_id":"abc"})
    for (const line of trimmed.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("{")) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmedLine) as Record<string, unknown>;
        for (const field of SESSION_ID_FIELDS) {
          const value = parsed[field];
          if (typeof value === "string" && value) {
            log.debug(
              `parseClaudeOutput: found session ID in field "${field}" (from line): ${value}`,
            );
            return { session_id: value };
          }
        }
      } catch {
        // not valid JSON on this line, continue to next
      }
    }
    log.debug(
      `parseClaudeOutput: no valid JSON with session ID found, parse error: ${String(parseError)}`,
    );
    return null;
  }
}

export type ClaudeCodeRunStatus = "pending" | "running" | "completed" | "error" | "timeout";

export type ClaudeCodeRunRecord = {
  runId: string;
  sessionKey: string;
  workspacePath: string;
  task: string;
  status: ClaudeCodeRunStatus;
  pid?: number;
  startedAt: number;
  endedAt?: number;
  outcome?: SubagentRunOutcome;
  output?: string;
  outputFile?: string;
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey?: string;
  label?: string;
  cleanup: "delete" | "keep";
  /** Internal: tracks whether finalizeRun has been called to prevent double-finalization */
  _finalized?: boolean;
};

const activeRuns = new Map<string, ClaudeCodeRunRecord>();
const processesByRunId = new Map<string, ChildProcess>();

/**
 * Register a new Claude Code run.
 */
export function registerClaudeCodeRun(params: {
  runId: string;
  sessionKey: string;
  workspacePath: string;
  task: string;
  requesterSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  requesterDisplayKey?: string;
  label?: string;
  cleanup: "delete" | "keep";
}): ClaudeCodeRunRecord {
  const record: ClaudeCodeRunRecord = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    workspacePath: params.workspacePath,
    task: params.task,
    status: "pending",
    startedAt: Date.now(),
    requesterSessionKey: params.requesterSessionKey,
    requesterOrigin: params.requesterOrigin,
    requesterDisplayKey: params.requesterDisplayKey,
    label: params.label,
    cleanup: params.cleanup,
  };
  activeRuns.set(params.runId, record);
  return record;
}

/**
 * Spawn a Claude Code process asynchronously.
 * The process runs in detached mode and callbacks are triggered on completion.
 */
export function spawnClaudeCodeProcess(params: {
  runId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  outputFile?: string;
  timeoutMs?: number;
}): void {
  const record = activeRuns.get(params.runId);
  if (!record) {
    log.warn(`No record found for runId: ${params.runId}`);
    return;
  }

  const env = { ...process.env, ...params.env };
  // Delete empty string values (used by clearEnv to unset variables)
  for (const [key, value] of Object.entries(params.env)) {
    if (value === "") {
      delete env[key];
    }
  }

  try {
    const childProcess = spawn(params.command, params.args, {
      cwd: params.cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    record.pid = childProcess.pid;
    record.status = "running";
    record.outputFile = params.outputFile;
    processesByRunId.set(params.runId, childProcess);

    // Emit start event
    emitAgentEvent({
      runId: params.runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: record.startedAt },
      sessionKey: record.sessionKey,
    });

    let stdout = "";
    let stderr = "";

    childProcess.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    childProcess.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timeoutId = params.timeoutMs
      ? setTimeout(() => {
          log.info(`Run ${params.runId} timed out after ${params.timeoutMs}ms`);
          record.status = "timeout";
          record.endedAt = Date.now();
          record.outcome = { status: "timeout" };
          try {
            childProcess.kill("SIGTERM");
          } catch {
            // ignore
          }
          void finalizeRun(params.runId);
        }, params.timeoutMs)
      : undefined;

    childProcess.on("exit", (code, signal) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      processesByRunId.delete(params.runId);

      const alreadyFinalized = record.status === "timeout" || record.status === "error";

      if (!alreadyFinalized) {
        record.endedAt = Date.now();
        record.output = stdout;

        if (code === 0) {
          record.status = "completed";
          record.outcome = { status: "ok" };
        } else if (signal) {
          record.status = "error";
          record.outcome = { status: "error", error: `Process killed by signal: ${signal}` };
        } else {
          record.status = "error";
          record.outcome = { status: "error", error: stderr || `Process exited with code ${code}` };
        }
      }

      void finalizeRun(params.runId);
    });

    childProcess.on("error", (err) => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      processesByRunId.delete(params.runId);

      record.status = "error";
      record.endedAt = Date.now();
      record.outcome = { status: "error", error: err.message };

      void finalizeRun(params.runId);
    });

    // Unref to allow parent process to exit independently
    childProcess.unref();

    log.info(`Spawned Claude Code process for run ${params.runId}, pid: ${childProcess.pid}`);
  } catch (err) {
    record.status = "error";
    record.endedAt = Date.now();
    record.outcome = { status: "error", error: String(err) };
    void finalizeRun(params.runId);
  }
}

/**
 * Finalize a run and trigger announce callback.
 * Idempotent: subsequent calls are no-ops if already finalized.
 */
async function finalizeRun(runId: string): Promise<void> {
  const record = activeRuns.get(runId);
  if (!record) {
    log.debug(`finalizeRun: no record found for runId ${runId}`);
    return;
  }

  // Idempotency check: prevent double-finalization
  if (record._finalized) {
    log.debug(`finalizeRun: runId ${runId} already finalized, skipping`);
    return;
  }
  record._finalized = true;

  log.debug(
    `finalizeRun: runId=${runId}, status=${record.status}, output length=${record.output?.length ?? 0}`,
  );

  // Extract and store Claude session ID for conversation continuity
  if (record.output && record.status === "completed") {
    log.debug(`finalizeRun: parsing output for session ID...`);
    try {
      const parsed = parseClaudeOutput(record.output);
      if (parsed?.session_id) {
        log.info(
          `finalizeRun: extracted session_id=${parsed.session_id}, updating store for workspace=${record.workspacePath}`,
        );
        const updated = updateClaudeSessionId(record.workspacePath, parsed.session_id);
        log.info(`finalizeRun: session ID store update result: ${updated}`);
      } else {
        log.warn(
          `finalizeRun: no session_id found in output. Output preview: ${record.output.slice(0, 500)}`,
        );
      }
    } catch (err) {
      log.warn(`finalizeRun: failed to parse Claude output for session ID: ${String(err)}`);
    }
  } else {
    log.debug(
      `finalizeRun: skipping session ID extraction (output=${!!record.output}, status=${record.status})`,
    );
  }

  // Emit end event
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: {
      phase: record.status === "completed" ? "end" : "error",
      endedAt: record.endedAt,
      error: record.outcome?.error,
      aborted: record.status === "timeout",
    },
    sessionKey: record.sessionKey,
  });

  // Trigger announce if we have requester info
  if (record.requesterSessionKey) {
    try {
      await runSubagentAnnounceFlow({
        childSessionKey: record.sessionKey,
        childRunId: runId,
        requesterSessionKey: record.requesterSessionKey,
        requesterOrigin: record.requesterOrigin,
        requesterDisplayKey: record.requesterDisplayKey ?? "unknown",
        task: record.task,
        timeoutMs: 30_000,
        cleanup: record.cleanup,
        waitForCompletion: false,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        label: record.label,
        outcome: record.outcome,
        roundOneReply: record.output,
      });
    } catch (err) {
      log.warn(`Failed to announce run ${runId}: ${String(err)}`);
    }
  }

  // Clean up record if delete mode
  if (record.cleanup === "delete") {
    activeRuns.delete(runId);
  }
}

/**
 * Get a run record by runId.
 */
export function getClaudeCodeRun(runId: string): ClaudeCodeRunRecord | undefined {
  return activeRuns.get(runId);
}

/**
 * List all active runs.
 */
export function listClaudeCodeRuns(): ClaudeCodeRunRecord[] {
  return Array.from(activeRuns.values());
}

/**
 * Get runs by session key.
 */
export function getClaudeCodeRunsBySession(sessionKey: string): ClaudeCodeRunRecord[] {
  return Array.from(activeRuns.values()).filter((r) => r.sessionKey === sessionKey);
}

/**
 * Abort a running process.
 */
export function abortClaudeCodeRun(runId: string): boolean {
  const record = activeRuns.get(runId);
  if (!record) {
    return false;
  }
  const process = processesByRunId.get(runId);
  if (process) {
    try {
      process.kill("SIGTERM");
      record.status = "error";
      record.endedAt = Date.now();
      record.outcome = { status: "error", error: "Aborted by user" };
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Send a message to a running process via stdin.
 * Note: This requires the process to be spawned with stdin pipe.
 */
export function sendToClaudeCodeRun(runId: string, _message: string): boolean {
  const process = processesByRunId.get(runId);
  if (!process) {
    return false;
  }
  // Claude Code CLI in non-interactive mode doesn't accept stdin input
  // This is a placeholder for future interactive mode support
  log.warn(`sendToClaudeCodeRun not supported for non-interactive mode: ${runId}`);
  return false;
}

/**
 * Reset the registry for tests.
 */
export function resetClaudeCodeRegistryForTests(): void {
  for (const process of processesByRunId.values()) {
    try {
      process.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  processesByRunId.clear();
  activeRuns.clear();
}
