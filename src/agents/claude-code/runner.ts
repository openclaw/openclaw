/**
 * Claude Code streaming NDJSON runner.
 *
 * Spawns the Claude Code CLI as a child process with bidirectional stream-json
 * I/O, parses the NDJSON protocol, and returns a structured result.
 *
 * Phase 2: bidirectional stream-json with progress relay and cost tracking.
 */

import { execSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveClaudeBinary } from "./binary.js";
import { activeSpawns, queuedSpawns, liveSessions, type LiveSession } from "./live-state.js";
import { startMcpBridge, type McpBridgeHandle } from "./mcp-bridge.js";
import type { CCAssistantMessage } from "./protocol.js";
import { parseOutboundMessage } from "./protocol.js";
import { peekSessionHistory, resolveSession, saveSession, updateSessionStats } from "./sessions.js";
import type {
  ClaudeCodePermissionMode,
  ClaudeCodeResult,
  ClaudeCodeSpawnOptions,
} from "./types.js";

const log = createSubsystemLogger("agent/claude-code");

// ---------------------------------------------------------------------------
// NDJSON debug logger — writes all stdin/stdout messages to a per-spawn file
// ---------------------------------------------------------------------------

const NDJSON_LOG_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "logs",
  "claude-code-ndjson",
);

function createNdjsonLogger(repoPath: string): {
  logStdin: (data: string) => void;
  logStdout: (data: string) => void;
  logStderr: (data: string) => void;
  close: () => void;
} {
  try {
    fs.mkdirSync(NDJSON_LOG_DIR, { recursive: true });
  } catch {
    // best-effort
  }
  const repoLabel = path.basename(repoPath);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(NDJSON_LOG_DIR, `${repoLabel}_${ts}.ndjson`);
  const stream = fs.createWriteStream(filePath, { flags: "a" });
  log.info(`NDJSON debug log: ${filePath}`);

  return {
    logStdin(data: string) {
      stream.write(`${JSON.stringify({ dir: "stdin", ts: Date.now(), data })}\n`);
    },
    logStdout(data: string) {
      stream.write(`${JSON.stringify({ dir: "stdout", ts: Date.now(), data })}\n`);
    },
    logStderr(data: string) {
      stream.write(`${JSON.stringify({ dir: "stderr", ts: Date.now(), data })}\n`);
    },
    close() {
      stream.end();
    },
  };
}

// ---------------------------------------------------------------------------
// Idle debounce — instead of specifically waiting for a `result` message
// (which CC CLI sometimes fails to emit — see anthropics/claude-code#3187,
// anthropics/claude-code#1920), we use
// a simple inactivity timer. Every NDJSON message resets the timer. When no
// messages arrive for IDLE_DEBOUNCE_MS, we assume the turn is done, kill the
// process, and synthesize a result from whatever we've captured.
//
// The `result` message is still handled as the happy path (instant return),
// but we no longer depend on it.
// ---------------------------------------------------------------------------

const IDLE_DEBOUNCE_MS = 30_000; // 30s of silence WHILE IDLE (not waiting for API)
export const PERSISTENT_IDLE_MS = 30 * 60 * 1_000; // 30 minutes default for persistent sessions

// ---------------------------------------------------------------------------
// Process tree check
// ---------------------------------------------------------------------------

/** Check if a process has active child processes (tool execution signal). */
function hasActiveChildren(pid: number | undefined): boolean {
  if (!pid) {
    return false;
  }
  try {
    // pgrep --parent returns 0 if children exist, 1 if none
    execSync(`pgrep --parent ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Arg builder
// ---------------------------------------------------------------------------

function buildArgs(options: ClaudeCodeSpawnOptions): string[] {
  const args = [
    "-p", // REQUIRED: non-interactive mode
    "--output-format",
    "stream-json", // NDJSON output
    "--input-format",
    "stream-json", // NDJSON input
    "--verbose", // REQUIRED for stream-json output
    "--setting-sources",
    "user,project,local",
    "--include-partial-messages",
  ];

  // Permission handling
  const mode: ClaudeCodePermissionMode = options.permissionMode ?? "bypassPermissions";
  if (mode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else if (mode === "default" || mode === "delegate") {
    // Phase 4: permission relay via stdio
    args.push("--permission-prompt-tool", "stdio");
  } else {
    args.push("--permission-mode", mode);
  }

  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.resume) {
    args.push("--resume", options.resume);
  } else if (options.continueSession) {
    args.push("--continue");
  }
  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }
  if (options.maxBudgetUsd != null) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  return args;
}

// ---------------------------------------------------------------------------
// Progress relay — assembles periodic progress summaries
// ---------------------------------------------------------------------------

type ProgressState = {
  lastRelayAt: number;
  intervalMs: number;
  enabled: boolean;
  includeToolUse: boolean;
  lastToolName: string | undefined;
  lastActivityText: string;
  accumulatedCostUsd: number;
  accumulatedTurns: number;
  timer: ReturnType<typeof setInterval> | null;
};

function createProgressState(options: ClaudeCodeSpawnOptions): ProgressState {
  const relay = options.progressRelay;
  const intervalSeconds = relay?.intervalSeconds ?? 30;
  return {
    lastRelayAt: Date.now(),
    intervalMs: intervalSeconds * 1_000,
    enabled: relay?.enabled !== false,
    includeToolUse: relay?.includeToolUse !== false,
    lastToolName: undefined,
    lastActivityText: "",
    accumulatedCostUsd: 0,
    accumulatedTurns: 0,
    timer: null,
  };
}

function buildProgressSummary(
  progress: ProgressState,
  repoPath: string,
  startedAt: number,
): string {
  const elapsedSec = Math.round((Date.now() - startedAt) / 1_000);
  const elapsed = formatDuration(elapsedSec);
  const cost =
    progress.accumulatedCostUsd > 0 ? `, $${progress.accumulatedCostUsd.toFixed(2)}` : "";
  const turns = progress.accumulatedTurns > 0 ? `, ${progress.accumulatedTurns} turns` : "";
  const repoLabel = path.basename(repoPath);
  const lastAction =
    progress.includeToolUse && progress.lastToolName
      ? `\n   Last action: ${progress.lastToolName}`
      : "";
  return `[${repoLabel}] Claude Code working... (${elapsed}${cost}${turns})${lastAction}`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

// ---------------------------------------------------------------------------
// Core spawn function
// ---------------------------------------------------------------------------

async function executeSpawn(options: ClaudeCodeSpawnOptions): Promise<ClaudeCodeResult> {
  // 1. Validate repo path
  const repoPath = path.resolve(options.repo);
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error(`Not a git repository: ${repoPath}`);
  }

  // 2. Resolve binary
  const binaryPath = resolveClaudeBinary(options.binaryPath);

  // 3. Resolve session for resume — only when explicitly requested
  const agentId = options.agentId ?? "default";
  const sessionToResume = options.resume;
  if (sessionToResume) {
    options = { ...options, resume: sessionToResume };
  }

  // 3b. Peek at previous session history for context when resuming/continuing
  let sessionContext = "";
  if (sessionToResume || options.continueSession) {
    const peekSessionId = sessionToResume ?? resolveSession(agentId, repoPath, options.label);
    if (peekSessionId) {
      sessionContext = peekSessionHistory(repoPath, peekSessionId, {
        maxMessages: 8,
        maxChars: 4000,
      });
      if (sessionContext) {
        log.info(`peeked session ${peekSessionId}: ${sessionContext.length} chars of context`);
      }
    }
  }

  // 4. Build args
  const args = buildArgs(options);

  // 5. Start MCP bridge server (if enabled)
  let bridge: McpBridgeHandle | null = null;
  if (options.mcpBridge?.enabled !== false) {
    try {
      bridge = await startMcpBridge(options);
      args.push(
        "--mcp-config",
        JSON.stringify({
          mcpServers: {
            "openclaw-bridge": bridge.mcpConfig,
          },
        }),
      );
    } catch (err) {
      log.warn(`MCP bridge failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 6. Spawn child process
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.CLAUDECODE; // CRITICAL: prevents nested session detection
  delete env.ANTHROPIC_API_KEY;

  log.info(
    `spawning claude-code: repo=${repoPath} ${options.continueSession ? "continue=true" : `resume=${sessionToResume ?? "none"}`} model=${options.model ?? "default"}`,
  );
  log.info(`claude-code args: ${JSON.stringify(args)}`);
  log.info(`claude-code binary: ${binaryPath}`);

  const child = spawn(binaryPath, args, {
    cwd: repoPath,
    stdio: ["pipe", "pipe", "pipe"],
    env: env as NodeJS.ProcessEnv,
  });

  child.on("error", (err) => {
    log.error(`claude-code spawn error: ${err.message}`);
  });

  child.on("exit", (code, signal) => {
    log.info(`claude-code process exited: code=${code} signal=${signal}`);
  });

  activeSpawns.set(repoPath, child);

  const startedAt = Date.now();
  const ndjsonLog = createNdjsonLogger(repoPath);

  // 7. Send initial task on stdin — keep stdin OPEN for multi-turn
  // When resuming, prepend previous session context so CC knows what happened
  let taskContent = options.task;
  if (sessionContext) {
    taskContent = [
      "<previous_session_context>",
      sessionContext,
      "</previous_session_context>",
      "",
      taskContent,
    ].join("\n");
  }
  const initMessage = JSON.stringify({
    type: "user",
    message: { role: "user", content: taskContent },
    uuid: crypto.randomUUID(),
  });
  child.stdin.write(initMessage + "\n");
  ndjsonLog.logStdin(initMessage);
  log.info(`claude-code stdin message sent (stdin kept open), pid=${child.pid}`);

  // 8. Set up timeout
  const timeoutSeconds = options.timeoutSeconds ?? 600;
  const timeoutMs = timeoutSeconds * 1_000;
  let timedOut = false;
  const timeoutHandler = () => {
    // Last-chance: check if CC has active child processes
    if (hasActiveChildren(child.pid)) {
      log.info(
        `spawn timeout: ${timeoutSeconds}s elapsed but CC has active children — extending by 5m`,
      );
      timeout = setTimeout(timeoutHandler, 5 * 60 * 1_000);
      return;
    }
    timedOut = true;
    log.warn(`claude-code timeout after ${timeoutSeconds}s, sending SIGTERM`);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  };
  // Persistent mode relies on the 30-min idle timeout instead
  let timeout: ReturnType<typeof setTimeout> | null = options.persistent
    ? null
    : setTimeout(timeoutHandler, timeoutMs);

  // 9. Collect stderr + handle spawn errors
  let stderrBuf = "";
  child.stderr?.on("data", (d: Buffer) => {
    const chunk = d.toString();
    stderrBuf += chunk;
    ndjsonLog.logStderr(chunk);
    if (chunk.trim()) {
      log.warn(`CC stderr: ${chunk.trim()}`);
    }
  });
  child.on("error", (err) => {
    log.error(`CC spawn error: ${err.message}`);
    if (timeout) {
      clearTimeout(timeout);
    }
    liveSessions.delete(repoPath);
    activeSpawns.delete(repoPath);
    ndjsonLog.close();
  });

  // 10. Set up progress relay
  const progress = createProgressState(options);

  // Register live session
  const persistent = options.persistent === true;
  const liveSession: LiveSession = {
    child,
    sessionId: undefined,
    repoPath,
    startedAt,
    accumulatedCostUsd: 0,
    accumulatedTurns: 0,
    lastToolName: undefined,
    lastActivityText: "",
    results: [],
    persistent,
    pendingFollowUp: null,
    persistentIdleTimer: null,
  };
  liveSessions.set(repoPath, liveSession);

  // Start periodic progress relay + announce drain
  if (progress.enabled && options.onProgress) {
    progress.timer = setInterval(() => {
      // Relay progress summary
      const summary = buildProgressSummary(progress, repoPath, startedAt);
      options.onProgress?.({ kind: "progress_summary", summary });

      // Drain bridge announcements (from openclaw_announce MCP tool)
      if (bridge) {
        const announcements = bridge.drainAnnouncements();
        for (const msg of announcements) {
          options.onProgress?.({ kind: "text", text: msg });
        }
      }
    }, progress.intervalMs);
  }

  // 11. Parse NDJSON stream
  let result: ClaudeCodeResult | null = null;
  let capturedSessionId: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let idleFired = false;
  // Track whether CC is waiting for an API response (between message_stop/user and
  // message_start). During this window, silence is expected — don't idle-kill.
  let waitingForApiResponse = false;
  // Track whether CC is executing a tool locally (between stop_reason="tool_use" on
  // assistant/message_delta and the next `user` tool_result). Silence is expected.
  let executingTool = false;

  // Persistent mode: promise plumbing for the first result
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- assigned synchronously inside Promise constructor
  let resolveFirstResult: ((r: ClaudeCodeResult) => void) | undefined;
  let rejectFirstResult: ((e: Error) => void) | undefined;
  let firstResultResolved = false;
  const firstResultPromise = persistent
    ? new Promise<ClaudeCodeResult>((resolve, reject) => {
        resolveFirstResult = resolve;
        rejectFirstResult = reject;
      })
    : null;

  /** Reset the long persistent idle timer (30 min). */
  const resetPersistentIdleTimer = () => {
    if (liveSession.persistentIdleTimer) {
      clearTimeout(liveSession.persistentIdleTimer);
    }
    liveSession.persistentIdleTimer = setTimeout(() => {
      log.warn(`persistent session idle for ${PERSISTENT_IDLE_MS}ms — killing process`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    }, PERSISTENT_IDLE_MS);
  };

  const resetIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    // Persistent sessions don't get killed by the short idle debounce
    if (persistent) {
      return;
    }
    // Don't start idle timer while CC is waiting for an API response or
    // executing a tool — silence is expected during those windows.
    if (waitingForApiResponse || executingTool) {
      return;
    }
    idleTimer = setTimeout(() => {
      // Last-chance check: does CC have active child processes?
      if (hasActiveChildren(child.pid)) {
        log.info(
          `idle debounce: ${IDLE_DEBOUNCE_MS}ms silence but CC has active children — extending`,
        );
        idleTimer = null;
        resetIdleTimer(); // will re-check flags and children next time
        return;
      }
      idleFired = true;
      log.warn(
        `idle debounce: no messages for ${IDLE_DEBOUNCE_MS}ms — assuming turn complete. ` +
          `Sending SIGTERM (workaround for CC CLI bug anthropics/claude-code#3187 / #1920).`,
      );
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5_000);
    }, IDLE_DEBOUNCE_MS);
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const rl = readline.createInterface({ input: child.stdout });
  let gotResult = false;

  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }

    ndjsonLog.logStdout(line);

    const msg = parseOutboundMessage(line);
    if (!msg) {
      log.debug(`non-JSON on stdout: ${line.slice(0, 200)}`);
      continue;
    }

    // Every valid message resets the idle debounce
    resetIdleTimer();

    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init") {
          capturedSessionId = msg.session_id;
          liveSession.sessionId = msg.session_id;
          log.info(`claude-code session init: sessionId=${msg.session_id} model=${msg.model}`);
          options.onProgress?.({
            kind: "status",
            permissionMode: msg.permissionMode,
            sessionId: msg.session_id,
          });
        } else if (msg.subtype === "status") {
          capturedSessionId = capturedSessionId ?? msg.session_id;
          options.onProgress?.({
            kind: "status",
            permissionMode: msg.permissionMode,
            sessionId: msg.session_id,
          });
        } else if (msg.subtype === "hook_started") {
          log.debug(`hook started: ${msg.hook_name}`);
        } else if (msg.subtype === "hook_response") {
          if (msg.exit_code != null && msg.exit_code !== 0) {
            options.onProgress?.({
              kind: "hook_failed",
              hookName: msg.hook_name,
              exitCode: msg.exit_code,
              output: msg.stderr || msg.output || "",
            });
          }
        } else if (msg.subtype === "task_notification") {
          options.onProgress?.({
            kind: "task_notification",
            taskId: msg.task_id,
            status: msg.status,
            summary: msg.summary,
          });
        }
        break;
      }

      case "assistant": {
        capturedSessionId = capturedSessionId ?? msg.session_id;
        // Track cost from assistant message usage
        if (msg.message.usage) {
          // Rough cost estimate: input_tokens * $3/MTok + output_tokens * $15/MTok (Opus pricing)
          // The actual cost comes from the result message; this is for progress display.
        }
        progress.accumulatedTurns += 1;
        liveSession.accumulatedTurns = progress.accumulatedTurns;
        // Track tool execution state from stop_reason
        if (msg.message.stop_reason === "tool_use") {
          executingTool = true;
        }
        // Reset spawn timeout — proof of real activity
        if (timeout) {
          if (timeout) {
            clearTimeout(timeout);
          }
          timeout = setTimeout(timeoutHandler, timeoutMs);
        }
        handleAssistantMessage(msg, options, progress, liveSession);
        break;
      }

      case "user": {
        // Tool results echoed back — CC finished executing tool, will make another API call.
        executingTool = false;
        waitingForApiResponse = true;
        break;
      }

      case "stream_event": {
        // Track API response state for idle timer
        if (msg.event?.type === "message_start") {
          // API response started streaming — no longer waiting
          waitingForApiResponse = false;
          executingTool = false;
        } else if (msg.event?.type === "message_stop") {
          // API response complete — CC will now execute tools or finish.
          waitingForApiResponse = false;
        } else if (msg.event?.type === "message_delta") {
          // message_delta arrives before assistant message — has early stop_reason
          const delta = (msg.event as Record<string, unknown>).delta as
            | Record<string, unknown>
            | undefined;
          if (delta?.stop_reason === "tool_use") {
            executingTool = true;
          }
        }
        // Partial deltas — extract text for progress display
        handleStreamEvent(msg, progress, liveSession);
        break;
      }

      case "auth_status": {
        if (msg.error) {
          child.kill("SIGTERM");
          throw new Error(
            "Claude Code authentication failed. " +
              "Run `claude` in a terminal to re-authenticate.",
          );
        }
        break;
      }

      case "control_response": {
        log.info(`control response: ${msg.response.subtype} for ${msg.response.request_id}`);
        break;
      }

      case "result": {
        if (timeout) {
          clearTimeout(timeout);
        }
        clearIdleTimer();
        waitingForApiResponse = false;
        const resultObj: ClaudeCodeResult = {
          success: msg.subtype === "success",
          sessionId: msg.session_id,
          result: msg.result ?? "",
          totalCostUsd: msg.total_cost_usd ?? 0,
          durationMs: msg.duration_ms ?? 0,
          durationApiMs: msg.duration_api_ms ?? 0,
          numTurns: msg.num_turns ?? 0,
          usage: msg.usage ?? { input_tokens: 0, output_tokens: 0 },
          permissionDenials: msg.permission_denials ?? [],
          errors: msg.errors ?? [],
        };
        // Update accumulated cost from the definitive result
        progress.accumulatedCostUsd = resultObj.totalCostUsd;
        liveSession.accumulatedCostUsd = resultObj.totalCostUsd;

        if (persistent) {
          // Push to results array
          liveSession.results.push(resultObj);
          // Resolve any pending follow-up promise
          if (liveSession.pendingFollowUp) {
            liveSession.pendingFollowUp.resolve(resultObj);
            liveSession.pendingFollowUp = null;
          }
          // Notify via progress callback
          options.onProgress?.({ kind: "result", result: resultObj });
          // First result? Resolve the initial spawn promise
          if (!firstResultResolved) {
            firstResultResolved = true;
            resolveFirstResult?.(resultObj);
          }
          // Reset idle timer for persistent keepalive
          resetPersistentIdleTimer();
          // DON'T break out of for-await — keep listening
        } else {
          // Existing one-shot behavior
          result = resultObj;
          gotResult = true;
        }
        break;
      }

      default: {
        log.debug(`unknown CC message type: ${(msg as { type: string }).type}`);
        break;
      }
    }

    // Break out of the for-await loop once we have a result.
    // Without this, readline keeps waiting for more stdout lines
    // (the process may linger), and the progress timer keeps firing.
    if (gotResult) {
      rl.close();
      break;
    }
  }

  // 12. Cleanup — persistent sessions handle cleanup differently
  const cleanupOneShot = () => {
    if (timeout) {
      clearTimeout(timeout);
    }
    clearIdleTimer();
    ndjsonLog.close();
    if (progress.timer) {
      clearInterval(progress.timer);
    }
    liveSessions.delete(repoPath);
  };

  if (persistent) {
    // For persistent mode, the for-await loop only exits when the process
    // dies (stdin closed by remote, SIGTERM, etc.). When that happens, clean up.
    // But first: return the first result to the caller while the loop is still running.

    // Set up background cleanup when the process eventually exits.
    const cleanupPersistent = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      clearIdleTimer();
      if (liveSession.persistentIdleTimer) {
        clearTimeout(liveSession.persistentIdleTimer);
      }
      ndjsonLog.close();
      if (progress.timer) {
        clearInterval(progress.timer);
      }
      liveSessions.delete(repoPath);
      activeSpawns.delete(repoPath);
      if (bridge) {
        bridge.stop().catch(() => {});
      }
      // Reject any pending follow-up
      if (liveSession.pendingFollowUp) {
        liveSession.pendingFollowUp.reject(new Error("Persistent session ended"));
        liveSession.pendingFollowUp = null;
      }
      // Reject first result if never received
      if (!firstResultResolved) {
        firstResultResolved = true;
        const stderr = stderrBuf.trim();
        rejectFirstResult?.(
          new Error(
            `Claude Code process exited without a result message.${stderr ? ` stderr: ${stderr}` : ""}`,
          ),
        );
      }
      drainQueue(repoPath);
    };

    child.on("close", cleanupPersistent);

    // Return the first result — the readline loop continues in the background
    return firstResultPromise!;
  }

  // --- One-shot cleanup path (unchanged) ---
  cleanupOneShot();

  // Kill the process if it's still running (e.g. after receiving result or idle debounce)
  if (!child.killed && child.exitCode === null) {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 5_000);
  }

  if (bridge) {
    try {
      await bridge.stop();
    } catch {
      // ignore
    }
  }
  activeSpawns.delete(repoPath);

  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
    } else {
      child.on("close", () => resolve());
    }
  });

  // 13. Handle missing result
  if (!result) {
    if (idleFired || progress.accumulatedTurns > 0) {
      // Either idle debounce fired, or CC did some work but exited without a result.
      // Synthesize a success result from what we captured.
      const durationMs = Date.now() - startedAt;
      const reason = idleFired
        ? `idle debounce (${IDLE_DEBOUNCE_MS}ms silence)`
        : "process exited without result message";
      log.warn(`synthesizing result: ${reason}`);
      return {
        success: true,
        sessionId: capturedSessionId ?? "",
        result: progress.lastActivityText || "(completed — result message missing from CC CLI)",
        totalCostUsd: progress.accumulatedCostUsd,
        durationMs,
        durationApiMs: 0,
        numTurns: progress.accumulatedTurns,
        usage: { input_tokens: 0, output_tokens: 0 },
        permissionDenials: [],
        errors: [`CC CLI did not emit result message. Synthesized via ${reason}.`],
      };
    }

    if (timedOut) {
      return {
        success: false,
        sessionId: capturedSessionId ?? "",
        result: "",
        totalCostUsd: 0,
        durationMs: timeoutSeconds * 1_000,
        durationApiMs: 0,
        numTurns: 0,
        usage: { input_tokens: 0, output_tokens: 0 },
        permissionDenials: [],
        errors: [`Timed out after ${timeoutSeconds}s`],
      };
    }

    const stderr = stderrBuf.trim();
    throw new Error(
      `Claude Code process exited without a result message.${stderr ? ` stderr: ${stderr}` : ""}`,
    );
  }

  // 14. Persist session
  const sessionId = result.sessionId || capturedSessionId || "";
  if (sessionId) {
    saveSession(agentId, repoPath, sessionId, {
      task: options.task,
      costUsd: result.totalCostUsd,
      label: options.label,
    });
    updateSessionStats(
      agentId,
      repoPath,
      { turns: result.numTurns, costUsd: result.totalCostUsd },
      options.label,
    );
  }

  // Drain queued spawn for this repo
  drainQueue(repoPath);

  return result;
}

// ---------------------------------------------------------------------------
// Assistant message handler
// ---------------------------------------------------------------------------

function handleAssistantMessage(
  msg: CCAssistantMessage,
  options: ClaudeCodeSpawnOptions,
  progress: ProgressState,
  liveSession: LiveSession,
): void {
  for (const block of msg.message.content) {
    if (block.type === "text" && block.text.trim()) {
      progress.lastActivityText = block.text.slice(0, 200);
      liveSession.lastActivityText = progress.lastActivityText;
      options.onProgress?.({ kind: "text", text: block.text });
    }
    if (block.type === "tool_use") {
      const toolBlock = block;
      progress.lastToolName = toolBlock.name;
      liveSession.lastToolName = toolBlock.name;

      // Phase 4: detect permission prompt tool_use and relay
      if (toolBlock.name === "permission_prompt" || toolBlock.name === "__permission_prompt") {
        const input = toolBlock.input;
        const toolName = typeof input.tool_name === "string" ? input.tool_name : toolBlock.name;
        const description =
          typeof input.description === "string"
            ? input.description
            : typeof input.command === "string"
              ? `Run: ${String(input.command)}`
              : `Tool: ${toolName}`;
        options.onProgress?.({
          kind: "permission_request",
          toolName,
          description,
          requestId: toolBlock.id,
        });
        options.onPermissionRequest?.({
          toolName,
          description,
          requestId: toolBlock.id,
        });
      } else {
        options.onProgress?.({
          kind: "tool_use",
          toolName: toolBlock.name,
          input: toolBlock.input,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Stream event handler — extract partial text for progress
// ---------------------------------------------------------------------------

function handleStreamEvent(
  msg: Record<string, unknown>,
  progress: ProgressState,
  liveSession: LiveSession,
): void {
  // stream_event messages contain content_block_delta with text fragments.
  // We extract the text for the "last activity" progress display.
  try {
    const blockDelta = msg.content_block_delta as Record<string, unknown> | undefined;
    const delta = blockDelta?.delta as Record<string, unknown> | undefined;
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      const text = delta.text.trim();
      if (text) {
        progress.lastActivityText = text.slice(0, 200);
        liveSession.lastActivityText = progress.lastActivityText;
      }
    }
  } catch {
    // Non-critical — ignore parse failures on stream events.
  }
}

// ---------------------------------------------------------------------------
// Queue management
// ---------------------------------------------------------------------------

function drainQueue(repoPath: string): void {
  const queued = queuedSpawns.get(repoPath);
  if (!queued) {
    return;
  }
  queuedSpawns.delete(repoPath);

  executeSpawn(queued.options).then(queued.resolve, queued.reject);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code CLI session.
 *
 * Enforces per-repo concurrency: max 1 running + 1 queued. The 3rd request is rejected.
 */
export async function spawnClaudeCode(options: ClaudeCodeSpawnOptions): Promise<ClaudeCodeResult> {
  const repoPath = path.resolve(options.repo);

  // Check active spawns
  if (activeSpawns.has(repoPath)) {
    // One is already running — check if we can queue
    if (queuedSpawns.has(repoPath)) {
      throw new Error(
        `Claude Code is already running and queued for ${repoPath}. ` +
          "Wait for the current run to finish.",
      );
    }

    log.info(`claude-code already running for ${repoPath}, queuing request`);
    return new Promise<ClaudeCodeResult>((resolve, reject) => {
      queuedSpawns.set(repoPath, { resolve, reject, options });
    });
  }

  return executeSpawn(options);
}

/**
 * Send a follow-up message to a persistent Claude Code session and wait for the result.
 * Returns a promise that resolves when the next `result` message arrives.
 */
export function sendFollowUpAndWait(
  repoPath: string,
  message: string,
  timeoutMs?: number,
): Promise<ClaudeCodeResult> {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session || !session.persistent) {
    return Promise.reject(new Error(`No persistent session for ${resolved}`));
  }
  if (!session.child.stdin?.writable) {
    return Promise.reject(new Error(`Session stdin not writable for ${resolved}`));
  }
  if (session.pendingFollowUp) {
    return Promise.reject(new Error("A follow-up is already pending"));
  }

  const promise = new Promise<ClaudeCodeResult>((resolve, reject) => {
    session.pendingFollowUp = { resolve, reject };

    // Optional timeout
    if (timeoutMs != null && timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (session.pendingFollowUp?.reject === reject) {
          session.pendingFollowUp = null;
          reject(new Error(`Follow-up timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      // Clear timeout when resolved
      const origResolve = resolve;
      const origReject = reject;
      session.pendingFollowUp = {
        resolve: (r) => {
          clearTimeout(timer);
          origResolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          origReject(e);
        },
      };
    }
  });

  // Send the follow-up message
  const followUp = JSON.stringify({
    type: "user",
    message: { role: "user", content: message },
    uuid: crypto.randomUUID(),
  });
  session.child.stdin.write(followUp + "\n");
  log.info(`follow-up (with wait) sent to persistent session on ${resolved}`);

  return promise;
}

/**
 * Stop a persistent Claude Code session. Sends SIGTERM, cleans up state.
 */
export function stopPersistentSession(repoPath: string): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session) {
    return false;
  }
  if (session.persistentIdleTimer) {
    clearTimeout(session.persistentIdleTimer);
    session.persistentIdleTimer = null;
  }
  // Reject any pending follow-up
  if (session.pendingFollowUp) {
    session.pendingFollowUp.reject(new Error("Persistent session stopped"));
    session.pendingFollowUp = null;
  }
  // SIGTERM the process — the child 'close' handler in executeSpawn will clean up
  // liveSessions and activeSpawns.
  if (!session.child.killed && session.child.exitCode === null) {
    session.child.kill("SIGTERM");
    setTimeout(() => {
      if (!session.child.killed) {
        session.child.kill("SIGKILL");
      }
    }, 5_000);
  }
  return true;
}

/**
 * Send a follow-up message to a running Claude Code session.
 * Returns true if the message was sent, false if no active session.
 */
export function sendFollowUp(repoPath: string, message: string): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session || !session.child.stdin?.writable) {
    return false;
  }

  const followUp = JSON.stringify({
    type: "user",
    message: { role: "user", content: message },
    uuid: crypto.randomUUID(),
  });
  session.child.stdin.write(followUp + "\n");
  log.info(`follow-up message sent to session on ${resolved}`);
  // Note: follow-up NDJSON logging not available here (logger is scoped to executeSpawn)
  return true;
}

/**
 * Respond to a permission request from a running Claude Code session.
 * Used by the permission relay (Phase 4) to send allow/deny responses.
 *
 * @param repoPath - Repo path of the running session
 * @param requestId - The tool_use ID from the permission_prompt block
 * @param allow - Whether to allow the action
 * @returns true if the response was sent
 */
export function respondToPermission(repoPath: string, requestId: string, allow: boolean): boolean {
  const resolved = path.resolve(repoPath);
  const session = liveSessions.get(resolved);
  if (!session || !session.child.stdin?.writable) {
    return false;
  }

  // Permission responses are sent as tool_result messages on stdin
  const response = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: requestId,
          type: "tool_result",
          content: JSON.stringify({
            approved: allow,
            // When denied, CC will log the denial
          }),
        },
      ],
    },
    uuid: crypto.randomUUID(),
  });
  session.child.stdin.write(response + "\n");
  log.info(`permission response sent: requestId=${requestId} allow=${allow}`);
  return true;
}

// Query/kill functions re-exported from live-state for barrel compatibility.
export {
  killClaudeCode,
  isClaudeCodeRunning,
  getLiveSession,
  getAllLiveSessions,
} from "./live-state.js";
