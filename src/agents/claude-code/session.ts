/**
 * Claude Code Session Manager
 *
 * Manages Claude Code as a subprocess, providing:
 * - Process lifecycle (start, cancel, send input)
 * - Session file watching for events
 * - Question detection and forwarding
 * - State tracking for UI updates
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  ClaudeCodeSessionParams,
  ClaudeCodeSessionData,
  SessionEvent,
  SessionState,
  SessionStatus,
  SessionStartResult,
  BlockerInfo,
} from "./types.js";
import { checkEventsForBlocker } from "./blocker-detector.js";
import { clearAttemptHistory } from "./orchestrator.js";
import {
  resolveProject,
  findSessionFile,
  getSessionDir,
  getGitBranch,
} from "./project-resolver.js";
import {
  SessionParser,
  extractRecentActions,
  getWaitingEvent,
  isSessionIdle,
} from "./session-parser.js";
import { getPhaseStatus } from "./progress-tracker.js";

const log = createSubsystemLogger("claude-code/session");

/**
 * Registry of active Claude Code sessions.
 */
const activeSessions = new Map<string, ClaudeCodeSessionData>();

/**
 * Get session by ID.
 */
export function getSession(sessionId: string): ClaudeCodeSessionData | undefined {
  return activeSessions.get(sessionId);
}

/**
 * Get session by resume token (or prefix).
 */
export function getSessionByToken(tokenOrPrefix: string): ClaudeCodeSessionData | undefined {
  for (const session of activeSessions.values()) {
    if (session.resumeToken === tokenOrPrefix || session.resumeToken.startsWith(tokenOrPrefix)) {
      return session;
    }
  }
  return undefined;
}

/**
 * List all active sessions.
 */
export function listSessions(): ClaudeCodeSessionData[] {
  return Array.from(activeSessions.values());
}

/**
 * Generate a short session ID.
 */
function generateSessionId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Start a new Claude Code session.
 */
export async function startSession(params: ClaudeCodeSessionParams): Promise<SessionStartResult> {
  const sessionId = generateSessionId();

  // Resolve project directory (either workingDir or project must be provided)
  let workingDir: string;
  let projectName: string;
  let branch: string;

  if (params.workingDir) {
    workingDir = params.workingDir;
    branch = getGitBranch(workingDir);

    // Detect if this is a worktree and extract project name properly
    // Worktree paths look like: /path/to/project/.worktrees/branch
    const worktreeMatch = workingDir.match(/^(.+)\/\.worktrees\/([^/]+)\/?$/);
    if (worktreeMatch) {
      // It's a worktree - use parent project name only (branch shown in ctx: line)
      projectName = path.basename(worktreeMatch[1]);
    } else {
      // Regular directory
      projectName = path.basename(workingDir);
    }
  } else if (params.project) {
    const resolved = resolveProject(params.project);
    if (!resolved) {
      return {
        success: false,
        error: `Project not found: ${params.project}`,
      };
    }
    workingDir = resolved.workingDir;
    projectName = resolved.displayName;
    branch = resolved.branch;
  } else {
    return {
      success: false,
      error: "Either project or workingDir must be provided",
    };
  }

  // Check if directory exists
  if (!fs.existsSync(workingDir)) {
    return {
      success: false,
      error: `Directory does not exist: ${workingDir}`,
    };
  }

  log.info(`Starting Claude Code session for ${projectName} in ${workingDir}`);
  log.info(`Prompt provided: ${params.prompt ? `"${params.prompt.slice(0, 100)}..."` : "(none)"}`);
  log.info(`Resume token: ${params.resumeToken || "(new session)"}`);

  // Build command arguments
  // IMPORTANT: -p (print mode) is required for --output-format stream-json
  // The prompt comes AFTER the -- separator, not as an argument to -p
  const args: string[] = [];

  // Enable print mode and JSON streaming (takopi-style)
  args.push("-p", "--output-format", "stream-json", "--verbose");

  // Resume existing session or start new
  if (params.resumeToken) {
    args.push("--resume", params.resumeToken);
  }

  // Model selection
  if (params.model) {
    args.push("--model", params.model);
  }

  // Permission mode
  const permissionMode = params.permissionMode ?? "default";
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  } else if (permissionMode === "acceptEdits") {
    args.push("--permission-mode", "acceptEdits");
  }

  // Add prompt after -- separator (required for stream-json mode)
  // CRITICAL: In -p mode, Claude NEEDS a prompt or it exits immediately!
  const prompt = params.prompt?.trim();
  if (prompt) {
    args.push("--", prompt);
  } else {
    // No prompt provided - use a fallback to prevent immediate exit
    const fallbackPrompt = params.resumeToken
      ? "continue"
      : "You are now in an interactive session. What would you like me to help with?";
    log.warn(`No prompt provided, using fallback: "${fallbackPrompt}"`);
    args.push("--", fallbackPrompt);
  }

  // Log the full command for debugging
  log.info(`Spawning: claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`);
  log.info(`CWD: ${workingDir}`);

  // Spawn Claude Code process
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("claude", args, {
      cwd: workingDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure we get JSON output for parsing
        TERM: "dumb",
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error(`Failed to spawn Claude Code: ${error}`);
    return {
      success: false,
      error: `Failed to start Claude Code: ${error}`,
    };
  }

  if (!child.pid) {
    return {
      success: false,
      error: "Failed to get process ID",
    };
  }

  // CRITICAL: Close stdin immediately after spawn (takopi-style)!
  // In -p mode with CLI arg prompt, Claude should process and exit.
  // Closing stdin signals there's no interactive input coming.
  // This is what takopi does - even when passing prompt as CLI arg, stdin is closed.
  //
  // Note: This means sendInput() won't work for this session.
  // For question answering, we'll need to resume the session with the answer.
  try {
    child.stdin.end();
    log.info(`[${sessionId}] Closed stdin (takopi-style)`);
  } catch (err) {
    log.warn(`[${sessionId}] Failed to close stdin: ${err}`);
  }

  // Create session data
  const sessionData: ClaudeCodeSessionData = {
    id: sessionId,
    resumeToken: params.resumeToken ?? "", // Will be updated when we find session file
    projectName,
    workingDir,
    sessionFile: "", // Will be updated when session starts
    child,
    pid: child.pid,
    startedAt: Date.now(),
    status: "starting",
    onEvent: params.onEvent,
    onQuestion: params.onQuestion,
    onStateChange: params.onStateChange,
    onBlocker: params.onBlocker,
    eventCount: 0,
    events: [],
    recentActions: [],
    phaseStatus: "Starting",
    branch,
    isResume: !!params.resumeToken, // Track if this is a resumed session
    sessionStartTime: Date.now(), // Record start time for filtering old events
  };

  // Register session
  activeSessions.set(sessionId, sessionData);

  // Setup process event handlers
  setupProcessHandlers(sessionData);

  // Start watching for session file
  startSessionFileWatcher(sessionData);

  // Notify state change
  notifyStateChange(sessionData);

  log.info(`Session ${sessionId} started with PID ${child.pid}`);

  return {
    success: true,
    sessionId,
    resumeToken: sessionData.resumeToken,
  };
}

/**
 * Setup handlers for the child process.
 * Uses takopi-style JSON stream parsing for direct session_id extraction.
 */
function setupProcessHandlers(session: ClaudeCodeSessionData): void {
  const { child } = session;
  if (!child) return;

  // Buffer for partial JSON lines
  let stdoutBuffer = "";

  // Capture stdout (JSON stream from --output-format stream-json)
  child.stdout.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString();

    // Process complete lines
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      // Parse JSON event
      try {
        const event = JSON.parse(line);
        processJsonStreamEvent(session, event);
      } catch {
        // Not valid JSON - might be non-JSON output, log for debugging
        log.debug(`[${session.id}] non-JSON stdout: ${line.slice(0, 100)}`);

        // Fallback: check for session token in text output
        if (!session.resumeToken) {
          const tokenMatch = line.match(/Resume token: ([a-f0-9-]{36})/i);
          if (tokenMatch) {
            session.resumeToken = tokenMatch[1];
            log.info(`[${session.id}] Found resume token (fallback): ${session.resumeToken}`);
          }
        }
      }
    }
  });

  // Capture stderr - log at INFO level to catch errors
  let stderrBuffer = "";
  child.stderr.on("data", (data: Buffer) => {
    const text = data.toString();
    stderrBuffer += text;
    // Log each chunk to see errors in real-time
    log.info(`[${session.id}] stderr: ${text.trim()}`);
  });

  // Handle process exit
  child.on("close", async (code, signal) => {
    log.info(`[${session.id}] Process exited with code=${code}, signal=${signal}`);
    log.info(`[${session.id}] Total events received: ${session.eventCount}`);
    log.info(`[${session.id}] Resume token: ${session.resumeToken || "(none)"}`);
    if (stderrBuffer.trim()) {
      log.info(`[${session.id}] Full stderr: ${stderrBuffer.trim().slice(0, 500)}`);
    }

    if (signal === "SIGTERM" || signal === "SIGKILL") {
      session.status = "cancelled";
    } else if (code === 0) {
      session.status = "completed";
    } else {
      session.status = "failed";
    }

    // Clear orchestrator attempt history for this session
    clearAttemptHistory(session.id);

    // Stop file watcher
    session.watcherAbort?.abort();

    // Check for blockers when session completes (not cancelled)
    if (session.status === "completed" || session.status === "failed") {
      const blocker = checkEventsForBlocker(session.events);
      if (blocker) {
        log.info(
          `[${session.id}] Blocker detected on exit: ${blocker.reason} (patterns: ${blocker.matchedPatterns.length})`,
        );
        session.blockerInfo = blocker;

        // If onBlocker callback is registered, let it handle the blocker
        if (session.onBlocker) {
          try {
            const handled = await session.onBlocker(blocker);
            if (handled) {
              log.info(`[${session.id}] Blocker will be handled by orchestrator`);
              session.status = "blocked"; // Orchestrator is working on it
            } else {
              log.info(`[${session.id}] Blocker not handled, staying in ${session.status} state`);
            }
          } catch (err) {
            log.error(`[${session.id}] onBlocker callback failed: ${err}`);
          }
        }
      }
    }

    // Notify state change
    notifyStateChange(session);

    // Keep session in registry for a while for status queries
    setTimeout(() => {
      activeSessions.delete(session.id);
    }, 60_000);
  });

  child.on("error", (err) => {
    log.error(`[${session.id}] Process error: ${err.message}`);
    session.status = "failed";
    notifyStateChange(session);
  });
}

/**
 * Start watching for session file location.
 *
 * Note: With takopi-style JSON streaming, we get events directly from stdout.
 * This watcher now only tracks the session file location for:
 * - Reconnection after restart (future feature)
 * - Session history/debugging
 *
 * It does NOT parse events from file - that would duplicate JSON stream events.
 */
function startSessionFileWatcher(session: ClaudeCodeSessionData): void {
  const abortController = new AbortController();
  session.watcherAbort = abortController;

  // Poll to find session file location (but don't parse events - JSON stream does that)
  const pollInterval = setInterval(() => {
    if (abortController.signal.aborted) {
      clearInterval(pollInterval);
      return;
    }

    // Already have session file, nothing to do
    if (session.sessionFile) {
      return;
    }

    // Find session file by resumeToken (if we have it from JSON stream)
    if (session.resumeToken) {
      const sessionFile = findSessionFile(session.resumeToken);
      if (sessionFile) {
        session.sessionFile = sessionFile;
        log.info(`[${session.id}] Found session file: ${sessionFile}`);
        return;
      }
    }

    // Fallback: scan directory for new session files
    // Only used if JSON stream init event hasn't arrived yet
    // IMPORTANT: Only pick up files created AFTER this session started
    const sessionDir = getSessionDir(session.workingDir);
    if (!fs.existsSync(sessionDir)) {
      return;
    }

    const files = fs
      .readdirSync(sessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const filePath = path.join(sessionDir, f);
        const stat = fs.statSync(filePath);
        return {
          name: f,
          path: filePath,
          mtime: stat.mtime.getTime(),
          ctime: stat.birthtime?.getTime() ?? stat.mtime.getTime(),
        };
      })
      // Only consider files created AFTER session started (with 5s grace)
      .filter((f) => f.ctime >= session.startedAt - 5000)
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      session.sessionFile = files[0].path;
      // Extract token from filename only if we don't have one from JSON stream
      const tokenMatch = files[0].name.match(/([a-f0-9-]{36})\.jsonl$/);
      if (tokenMatch && !session.resumeToken) {
        session.resumeToken = tokenMatch[1];
        log.info(
          `[${session.id}] Got resumeToken from file scan (fallback): ${session.resumeToken}`,
        );
      }
      log.info(`[${session.id}] Found session file: ${session.sessionFile}`);
    }
  }, 1000);

  // Store cleanup function
  abortController.signal.addEventListener("abort", () => {
    clearInterval(pollInterval);
  });
}

/**
 * Process a JSON stream event from Claude's --output-format stream-json.
 * Takopi-style: extracts session_id from init event, converts to SessionEvent.
 */
function processJsonStreamEvent(
  session: ClaudeCodeSessionData,
  jsonEvent: Record<string, unknown>,
): void {
  const eventType = jsonEvent.type as string | undefined;

  // Handle system init event - extract session_id directly (takopi approach)
  if (eventType === "system") {
    const subtype = jsonEvent.subtype as string | undefined;
    if (subtype === "init" && jsonEvent.session_id) {
      const sessionId = jsonEvent.session_id as string;
      if (!session.resumeToken || session.resumeToken !== sessionId) {
        session.resumeToken = sessionId;
        log.info(`[${session.id}] Got session_id from init event: ${sessionId}`);
      }
      // Also update status
      if (session.status === "starting") {
        session.status = "running";
      }
      notifyStateChange(session);
    }
    return;
  }

  // Handle result event - session completed
  if (eventType === "result") {
    const isError = jsonEvent.is_error as boolean | undefined;
    const resultText = jsonEvent.result as string | undefined;

    // Convert to SessionEvent
    const event: SessionEvent = {
      type: "assistant_message",
      timestamp: new Date(),
      text: resultText || (isError ? "Session ended with error" : "Session completed"),
    };
    processEvent(session, event);

    // Mark session as completed
    if (isError) {
      session.status = "failed";
    }
    return;
  }

  // Handle assistant message - extract text and tool use
  if (eventType === "assistant") {
    const message = jsonEvent.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as Array<Record<string, unknown>> | undefined;
      if (content && Array.isArray(content)) {
        for (const block of content) {
          const blockType = block.type as string | undefined;

          // Text block - assistant message
          if (blockType === "text" && block.text) {
            const event: SessionEvent = {
              type: "assistant_message",
              timestamp: new Date(),
              text: block.text as string,
            };
            processEvent(session, event);
          }

          // Tool use block
          if (blockType === "tool_use") {
            const event: SessionEvent = {
              type: "tool_use",
              timestamp: new Date(),
              toolName: block.name as string | undefined,
              toolInput: JSON.stringify(block.input ?? {}),
            };
            processEvent(session, event);
          }
        }
      }
    }
    return;
  }

  // Handle user message - tool results
  if (eventType === "user") {
    const message = jsonEvent.message as Record<string, unknown> | undefined;
    if (message) {
      const content = message.content as Array<Record<string, unknown>> | string | undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          const blockType = block.type as string | undefined;
          if (blockType === "tool_result") {
            const event: SessionEvent = {
              type: "tool_result",
              timestamp: new Date(),
              toolUseId: block.tool_use_id as string | undefined,
              result:
                typeof block.content === "string" ? block.content : JSON.stringify(block.content),
              isError: block.is_error as boolean | undefined,
            };
            processEvent(session, event);
          }
        }
      } else if (typeof content === "string") {
        // Plain user message
        const event: SessionEvent = {
          type: "user_message",
          timestamp: new Date(),
          text: content,
        };
        processEvent(session, event);
      }
    }
    return;
  }
}

/**
 * Process a session event.
 */
function processEvent(session: ClaudeCodeSessionData, event: SessionEvent): void {
  // For resumed sessions, skip events that happened before we started
  // This filters out old history while still catching new events
  if (session.isResume && session.sessionStartTime) {
    const eventTime = event.timestamp.getTime();
    // Allow 5 second buffer before session start to catch events written during startup
    if (eventTime < session.sessionStartTime - 5000) {
      log.debug(
        `[${session.id}] Skipping old event (${event.type}) from ${event.timestamp.toISOString()}`,
      );
      return; // Skip old event
    }
    log.debug(
      `[${session.id}] Processing new event (${event.type}) from ${event.timestamp.toISOString()}`,
    );
  }

  session.eventCount++;
  session.events.push(event);

  // Keep events buffer bounded
  if (session.events.length > 1000) {
    session.events = session.events.slice(-500);
  }

  // Update status based on event
  if (session.status === "starting") {
    session.status = "running";
  }

  // Update recent actions using the parser helper
  session.recentActions = extractRecentActions(session.events, 10);

  // Update phase status from project files periodically (every 10 events)
  if (session.eventCount % 10 === 0) {
    session.phaseStatus = getPhaseStatus(session.workingDir);
  }

  // Check for questions using the parser helper
  const waitingEvent = getWaitingEvent(session.events);
  if (waitingEvent && waitingEvent.text) {
    session.status = "waiting_for_input";
    session.currentQuestion = waitingEvent.text;

    // Invoke question callback (only once per question)
    if (session.onQuestion && event === waitingEvent) {
      session
        .onQuestion(waitingEvent.text)
        .then((answer) => {
          if (answer) {
            sendInput(session.id, answer);
          }
        })
        .catch((err) => {
          log.error(`[${session.id}] Question handler error: ${err}`);
        });
    }
  } else if (event.type === "user_message") {
    // User responded, clear question state
    session.currentQuestion = undefined;
    session.status = "running";
  } else if (isSessionIdle(session.events)) {
    session.status = "idle";
  } else if (event.type === "tool_use") {
    session.status = "running";
  }

  // Notify event callback
  if (session.onEvent) {
    session.onEvent(event);
  }

  // Notify state change
  notifyStateChange(session);
}

/**
 * Notify state change callback.
 */
function notifyStateChange(session: ClaudeCodeSessionData): void {
  const state = getSessionState(session);

  // CRITICAL: Block stale updates after session has ended
  // This prevents race conditions where buffered events trigger callbacks after exit
  const isSessionEnded =
    session.status === "completed" ||
    session.status === "cancelled" ||
    session.status === "failed" ||
    session.status === "blocked";

  if (session.finalStateNotified && isSessionEnded) {
    log.info(
      `[${session.id}] Ignoring redundant end-state callback (status=${state.status}, already finalized)`,
    );
    return;
  }

  // Log state change for debugging bubble sync issues
  log.info(
    `[${session.id}] State change: status=${state.status}, token=${session.resumeToken?.slice(0, 8) || "none"}, hasCallback=${!!session.onStateChange}`,
  );

  if (!session.onStateChange) {
    log.warn(`[${session.id}] No onStateChange callback registered - bubble will NOT be updated`);
    return;
  }

  // Mark final state as notified to prevent duplicates
  if (isSessionEnded) {
    session.finalStateNotified = true;
  }

  try {
    session.onStateChange(state);
    log.debug(`[${session.id}] onStateChange callback executed successfully`);
  } catch (err) {
    log.error(`[${session.id}] onStateChange callback failed: ${err}`);
  }
}

/**
 * Get current session state.
 */
export function getSessionState(session: ClaudeCodeSessionData): SessionState {
  const runtimeSeconds = (Date.now() - session.startedAt) / 1000;
  const hours = Math.floor(runtimeSeconds / 3600);
  const minutes = Math.floor((runtimeSeconds % 3600) / 60);
  const runtimeStr = `${hours}h ${minutes}m`;

  return {
    status: session.status,
    projectName: session.projectName,
    resumeToken: session.resumeToken,
    runtimeStr,
    runtimeSeconds,
    phaseStatus: session.phaseStatus,
    branch: session.branch,
    recentActions: [...session.recentActions],
    hasQuestion: session.status === "waiting_for_input",
    questionText: session.currentQuestion ?? "",
    totalEvents: session.eventCount,
    isIdle: session.status === "idle",
    blockerInfo: session.blockerInfo,
  };
}

/**
 * Send input to a running session.
 *
 * Note: With takopi-style spawning (stdin closed immediately), this won't work.
 * For question answering in -p mode, the session needs to be resumed with the
 * answer as a new prompt instead.
 */
export function sendInput(sessionId: string, text: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session || !session.child || session.child.killed) {
    log.warn(`Cannot send input to session ${sessionId}: not running`);
    return false;
  }

  // Check if stdin is still writable
  if (!session.child.stdin.writable) {
    log.warn(
      `[${sessionId}] Cannot send input: stdin is closed. ` +
        `With takopi-style spawning, use session resume instead.`,
    );
    return false;
  }

  try {
    session.child.stdin.write(text + "\n");
    log.info(`[${sessionId}] Sent input: ${text.slice(0, 50)}...`);
    return true;
  } catch (err) {
    log.error(`[${sessionId}] Failed to send input: ${err}`);
    return false;
  }
}

/**
 * Cancel a running session.
 */
export function cancelSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    log.warn(`Cannot cancel session ${sessionId}: not found`);
    return false;
  }

  log.info(`Cancelling session ${sessionId}`);

  // Stop file watcher
  session.watcherAbort?.abort();

  // Kill process
  if (session.child && !session.child.killed) {
    session.child.kill("SIGTERM");

    // Force kill after timeout
    setTimeout(() => {
      if (session.child && !session.child.killed) {
        session.child.kill("SIGKILL");
      }
    }, 5000);
  }

  session.status = "cancelled";
  notifyStateChange(session);

  return true;
}

/**
 * Cancel session by token prefix.
 */
export function cancelSessionByToken(tokenOrPrefix: string): boolean {
  const session = getSessionByToken(tokenOrPrefix);
  if (!session) {
    return false;
  }
  return cancelSession(session.id);
}
