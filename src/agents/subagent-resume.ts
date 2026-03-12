/**
 * Subagent restart recovery — Phase 1.
 *
 * When the gateway restarts mid-run, subagent sessions that were in-flight lose
 * their running agent process. `waitForSubagentCompletion` → `agent.wait` then
 * fails silently because the agent process is gone, leaving runs in limbo or
 * mis-classifying them as timeouts.
 *
 * This module provides:
 *  1. `rehydrateSessionStoreEntries` — injects synthetic session-store entries
 *     for runs whose session-store entry went missing in the ~400 ms race window
 *     between spawn and first session-store write.  Called in
 *     `restoreSubagentRunsOnce` **before** `reconcileOrphanedRestoredRuns` so
 *     the orphan check sees the rehydrated entry.
 *
 *  2. `resolveSubagentRunResumability` — replaces the binary orphan/no-orphan
 *     check with a 4-way classification so `resumeSubagentRun` can choose the
 *     right recovery path without blindly calling `agent.wait`.
 *
 *  3. `recoverCompletedSubagentRunFromTranscript` / `redispatchSubagentRunAfterRestart`
 *     — handlers for the two resumable sub-cases.
 *
 * Phase 2 (not in this PR): synthetic tool_result injection, SIGTERM
 * checkpointing, per-run max-resume caps.
 *
 * Related issues: #27875, #19780, #20436
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveSessionFilePath,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("agents/subagent-resume");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * 4-way resumability classification for a single in-flight registry entry.
 *
 * - `resumable-announce-only`  — `endedAt` is already set; the run completed
 *   before restart, the announce delivery just needs to be retried.
 * - `resumable-replay`         — transcript ends with a completed assistant
 *   turn (no pending `tool_use` blocks) and `endedAt` is unset; the run
 *   finished but its completion was never recorded in the registry.  Capture
 *   the result from the transcript and complete.
 * - `resumable-fresh`          — session-store entry exists, transcript is
 *   empty / session-header only, `endedAt` is unset; the agent process was
 *   spawned but never ran.  Re-dispatch the original task.
 * - `orphaned`                 — no session-store entry AND no recoverable
 *   transcript, or transcript has zero model turns (spawn began but aborted
 *   before writing anything useful).
 */
export type SubagentRunResumability =
  | "orphaned"
  | "resumable-announce-only"
  | "resumable-replay"
  | "resumable-fresh";

// ---------------------------------------------------------------------------
// Low-level transcript helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Read the first line of a `.jsonl` transcript file and return the session id
 * embedded in the `{type:'session', id:'<uuid>'}` header.  Returns `null` on
 * any error or when the header is absent / malformed.
 */
export function readTranscriptSessionId(transcriptPath: string): string | null {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const firstLine = content.split("\n")[0]?.trim();
    if (!firstLine) {
      return null;
    }
    const parsed = JSON.parse(firstLine) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "session" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const id = ((parsed as Record<string, unknown>).id as string).trim();
      return id || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Return `true` when the transcript at `transcriptPath` contains at least one
 * `{type:'message', message:{role:'assistant'}}` line.  Returns `false` on any
 * error or when the file is absent.
 */
export function transcriptHasAssistantTurn(transcriptPath: string): boolean {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          (parsed as Record<string, unknown>).type === "message"
        ) {
          const msg = (parsed as Record<string, unknown>).message;
          if (
            msg !== null &&
            typeof msg === "object" &&
            (msg as Record<string, unknown>).role === "assistant"
          ) {
            return true;
          }
        }
      } catch {
        // ignore malformed lines
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Return `true` when the transcript's **last** message line is an assistant
 * turn that contains **no** pending `tool_use` content blocks.
 *
 * An assistant turn qualifies as a completed final turn only when:
 *  - It is the very last message in the transcript (nothing follows it), AND
 *  - Its `content` array contains only non-`tool_use` blocks (e.g. `text`).
 *
 * Returns `false` (i.e. "not definitely complete") when:
 *  - The transcript does not end with an assistant turn — e.g. it ends with a
 *    user message or tool-result turn (run was interrupted mid-tool-use or
 *    still awaiting further input).
 *  - The last assistant turn contains `tool_use` blocks (run was cut off while
 *    waiting for the tool result to come back).
 *  - There are no message lines at all (session header only, or empty file).
 *  - The file is absent or unreadable.
 *
 * When in doubt this function returns `false` so callers fall back to the
 * safer `resumable-fresh` path rather than incorrectly marking a run as done.
 */
export function transcriptEndsWithCompletedAssistantTurn(transcriptPath: string): boolean {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n");

    // Walk from the end to find the last non-empty, parseable message line.
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Malformed line — skip it and keep looking backward.
        continue;
      }

      if (parsed === null || typeof parsed !== "object") {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      if (record.type !== "message") {
        // Session header or other non-message record; keep scanning backward.
        continue;
      }

      // Found the last message line — check if it's a completed assistant turn.
      const msg = record.message;
      if (msg === null || typeof msg !== "object") {
        return false;
      }
      const msgRecord = msg as Record<string, unknown>;
      if (msgRecord.role !== "assistant") {
        // Last turn is not from the assistant (e.g. user / tool-result turn) —
        // the run was interrupted before the assistant could reply.
        return false;
      }

      // Check that the content array has no pending tool_use blocks.
      const contentArr = msgRecord.content;
      if (!Array.isArray(contentArr)) {
        // Non-array content (e.g. plain string) — treat as a completed text turn.
        return true;
      }
      const hasPendingToolUse = contentArr.some(
        (block) =>
          block !== null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_use",
      );
      // If there are outstanding tool_use blocks the run is mid-tool-use, not done.
      return !hasPendingToolUse;
    }

    // No message lines found at all.
    return false;
  } catch {
    return false;
  }
}

/**
 * Return the timestamp (epoch ms) of the last **completed** assistant turn in
 * the transcript, or `null` if no completed assistant turn exists.
 *
 * A "completed" turn is an assistant message whose `content` array contains no
 * pending `tool_use` blocks.  The same backward-scan logic as
 * `transcriptEndsWithCompletedAssistantTurn` is used, but this function also
 * returns the turn's timestamp so callers can compare it against a run-start
 * boundary to detect stale output left by a prior run on the same session.
 *
 * Timestamp parsing is best-effort: ISO-8601 strings and epoch-ms numbers are
 * both accepted.  Returns `null` when the timestamp is absent or unparseable.
 */
export function transcriptLastCompletedAssistantTurnTimestamp(
  transcriptPath: string,
): number | null {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n");

    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (parsed === null || typeof parsed !== "object") {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      if (record.type !== "message") {
        continue;
      }

      const msg = record.message;
      if (msg === null || typeof msg !== "object") {
        return null;
      }

      const msgRecord = msg as Record<string, unknown>;
      if (msgRecord.role !== "assistant") {
        // Last turn is not from the assistant — no completed assistant turn here.
        return null;
      }

      const contentArr = msgRecord.content;
      if (!Array.isArray(contentArr)) {
        // Non-array content (plain string) — treat as a completed text turn.
        return parseRecordTimestampToMs(record);
      }

      const hasPendingToolUse = contentArr.some(
        (block) =>
          block !== null &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "tool_use",
      );

      if (hasPendingToolUse) {
        // Last assistant turn has pending tool_use — not a completed turn.
        return null;
      }

      return parseRecordTimestampToMs(record);
    }

    // No message lines found at all.
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse a `timestamp` field from a JSONL transcript record into epoch ms.
 * Accepts ISO-8601 strings and numeric epoch-ms values.  Returns `null` when
 * the field is absent, empty, or cannot be parsed.
 */
function parseRecordTimestampToMs(record: Record<string, unknown>): number | null {
  const ts = record.timestamp;
  if (typeof ts === "number" && ts > 0 && Number.isFinite(ts)) {
    return ts;
  }
  if (typeof ts === "string" && ts.trim()) {
    const ms = Date.parse(ts);
    if (!Number.isNaN(ms)) {
      return ms;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session-store helper (private)
// ---------------------------------------------------------------------------

function findEntryByKey(
  store: Record<string, SessionEntry>,
  sessionKey: string,
): SessionEntry | undefined {
  const direct = store[sessionKey];
  if (direct) {
    return direct;
  }
  const normalized = sessionKey.toLowerCase();
  for (const [k, v] of Object.entries(store)) {
    if (k.toLowerCase() === normalized) {
      return v;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Sessions-directory scanner (private, used by rehydrateSessionStoreEntries)
// ---------------------------------------------------------------------------

/**
 * Scan `sessionsDir` for a `.jsonl` transcript whose creation time is close to
 * `targetCreatedAtMs` (within `toleranceMs`).  Uses `stat.birthtimeMs`
 * (creation time) as the primary signal.  On platforms that do not support
 * birth-time (Linux filesystems where `birthtimeMs === mtimeMs`), `mtimeMs` is
 * used as a proxy for creation time.
 *
 * Returns the absolute path of the candidate if exactly one candidate is found,
 * otherwise `null`.
 *
 * The one-candidate constraint prevents false matches when multiple subagents
 * were spawned at nearly the same time; in that case rehydration is skipped
 * (best-effort) and the orphan logic runs instead.
 */
function scanSessionsDirForTranscriptCandidate(
  sessionsDir: string,
  targetCreatedAtMs: number,
  toleranceMs: number,
): string | null {
  try {
    const files = fs.readdirSync(sessionsDir);
    const candidates: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        // Use birthtimeMs (creation time) as the primary signal.
        // On Linux filesystems that do not report birth-time, birthtimeMs equals
        // mtimeMs; in that case fall back to mtimeMs as a reasonable proxy.
        const fileCreatedAtMs = stat.birthtimeMs !== stat.mtimeMs ? stat.birthtimeMs : stat.mtimeMs;
        const timeDiffMs = Math.abs(fileCreatedAtMs - targetCreatedAtMs);
        // No upper age bound: a run that started hours before a restart must
        // still be recoverable.  The toleranceMs window relative to the
        // registry entry's createdAt already constrains the match tightly.
        if (timeDiffMs <= toleranceMs) {
          candidates.push(fullPath);
        }
      } catch {
        // ignore stat failures for individual files
      }
    }
    return candidates.length === 1 ? (candidates[0] ?? null) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Change 1: rehydrateSessionStoreEntries
// ---------------------------------------------------------------------------

/**
 * Inject synthetic session-store entries for in-flight registry runs whose
 * session-store entry is missing.
 *
 * Called in `restoreSubagentRunsOnce` **before** `reconcileOrphanedRestoredRuns`
 * so that the orphan-reason check sees a populated store entry rather than
 * returning `"missing-session-entry"` and incorrectly pruning the run.
 *
 * Strategy
 * --------
 * 1. For every in-flight entry (no `endedAt`), force a cache-bypassing read of
 *    the relevant `sessions.json`.  This handles the common race where the
 *    session-store write completed but the in-memory cache is stale.
 * 2. If still missing after the fresh read, scan the agent's sessions directory
 *    for a single `.jsonl` file created within a 5-minute tolerance of the
 *    registry entry's `createdAt`.  If exactly one candidate is found, read its
 *    session header to extract the `sessionId` and write a minimal synthetic
 *    store entry.
 *
 * Both steps are best-effort: any failure is logged at debug level and silently
 * ignored so that the normal orphan-pruning path can still fire.
 */
export async function rehydrateSessionStoreEntries(
  entries: Map<string, SubagentRunRecord>,
): Promise<void> {
  const TOLERANCE_MS = 5 * 60_000; // 5 minutes

  for (const entry of entries.values()) {
    if (typeof entry.endedAt === "number") {
      // Already done — nothing to rehydrate.
      continue;
    }

    const childSessionKey = entry.childSessionKey?.trim();
    if (!childSessionKey) {
      continue;
    }

    try {
      const cfg = loadConfig();
      const agentId = resolveAgentIdFromSessionKey(childSessionKey);
      const storePath = resolveStorePath(cfg.session?.store, { agentId });

      // Step 1: force a fresh (no-cache) read of the session store.
      const store = loadSessionStore(storePath, { skipCache: true });
      if (findEntryByKey(store, childSessionKey)) {
        // Entry found — no rehydration needed.
        continue;
      }

      // Step 2: session-store entry is genuinely missing; try to find the
      // transcript by scanning the sessions directory.
      const sessionsDir = path.dirname(storePath);
      const targetCreatedAtMs = entry.createdAt ?? Date.now();
      const transcriptPath = scanSessionsDirForTranscriptCandidate(
        sessionsDir,
        targetCreatedAtMs,
        TOLERANCE_MS,
      );
      if (!transcriptPath) {
        log.debug("rehydrate: no transcript candidate found", { childSessionKey });
        continue;
      }

      const sessionId = readTranscriptSessionId(transcriptPath);
      if (!sessionId) {
        log.debug("rehydrate: transcript has no session header", { childSessionKey });
        continue;
      }

      // Build a minimal synthetic session-store entry.
      // Derive the child's spawn depth from the requester's depth rather than
      // hardcoding 1, so that recovered depth-2+ runs are classified correctly
      // by getSubagentDepthFromSessionStore (which prefers stored spawnDepth
      // over ancestry traversal).
      const requesterSpawnDepth = getSubagentDepthFromSessionStore(entry.requesterSessionKey, {
        cfg,
      });
      const childSpawnDepth = requesterSpawnDepth + 1;
      const sessionFile = path.relative(sessionsDir, transcriptPath);
      const synthetic: SessionEntry = {
        sessionId,
        updatedAt: targetCreatedAtMs,
        sessionFile,
        spawnedBy: entry.requesterSessionKey,
        spawnDepth: childSpawnDepth,
      };

      // Write the synthetic entry via updateSessionStore so that concurrent
      // session-store writes during startup are serialised through the lock.
      const normalizedKey = childSessionKey.toLowerCase();
      try {
        await updateSessionStore(storePath, (freshStore) => {
          if (!findEntryByKey(freshStore, childSessionKey)) {
            freshStore[normalizedKey] = synthetic;
            log.info("rehydrated session store entry", { childSessionKey, sessionId });
          }
        });
      } catch (writeErr) {
        log.debug("rehydrate: session-store write failed", {
          childSessionKey,
          error: String(writeErr),
        });
      }
    } catch (err) {
      // Best-effort — any config/IO error is silently swallowed.
      log.debug("rehydrate: unexpected error", {
        childSessionKey: entry.childSessionKey,
        error: String(err),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Change 2: resolveSubagentRunResumability
// ---------------------------------------------------------------------------

/**
 * Classify an in-flight registry entry into one of four resumability states.
 *
 * Callers must call `rehydrateSessionStoreEntries` first so that synthetic
 * session-store entries are available for the `missing-session-entry` recovery
 * path.
 *
 * @param entry   The registry entry to classify.
 * @param opts    Optional overrides for testing (e.g. transcript path).
 */
export function resolveSubagentRunResumability(
  entry: SubagentRunRecord,
  opts?: {
    transcriptPath?: string;
    /**
     * Override the run-start boundary used for the stale-transcript check.
     * Defaults to `entry.startedAt ?? entry.createdAt`.  Pass a value here in
     * tests to control the comparison without manipulating real timestamps.
     */
    runStartMs?: number;
  },
): SubagentRunResumability {
  // ① Already completed — just needs announce retry.
  if (typeof entry.endedAt === "number" && entry.endedAt > 0) {
    return "resumable-announce-only";
  }

  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "orphaned";
  }

  // ② Look up session-store entry.
  let sessionId: string | null = null;
  let sessionEntryForPath: SessionEntry | undefined;
  let sessionsDir: string | undefined;
  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(childSessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath, { skipCache: true });
    const sessionEntry = findEntryByKey(store, childSessionKey);
    if (
      sessionEntry &&
      typeof sessionEntry.sessionId === "string" &&
      sessionEntry.sessionId.trim()
    ) {
      sessionId = sessionEntry.sessionId.trim();
      sessionEntryForPath = sessionEntry;
      sessionsDir = path.dirname(storePath);
    }
  } catch {
    // Best-effort — treat as if session store is missing.
  }

  if (!sessionId) {
    // No session-store entry even after rehydration → orphaned.
    return "orphaned";
  }

  // ③ Resolve transcript path.
  // Use resolveSessionFilePath so that sessions with non-standard transcript
  // paths (sessionFile field set) are handled correctly, consistent with all
  // other transcript-locating code in the codebase.
  let transcriptPath: string;
  if (opts?.transcriptPath) {
    transcriptPath = opts.transcriptPath;
  } else {
    try {
      transcriptPath = resolveSessionFilePath(sessionId, sessionEntryForPath, {
        sessionsDir,
      });
    } catch {
      return "orphaned";
    }
  }

  // ④ Check transcript content.
  const transcriptExists = fs.existsSync(transcriptPath);
  if (!transcriptExists) {
    // Session-store entry exists but no transcript was ever written.
    // The agent was registered but never actually ran.
    return "resumable-fresh";
  }

  const lastAssistantTurnMs = transcriptLastCompletedAssistantTurnTimestamp(transcriptPath);
  if (lastAssistantTurnMs !== null) {
    // The transcript has a completed assistant turn — but verify it belongs to
    // the CURRENT run, not a prior run that shared the same childSessionKey.
    //
    // After replaceSubagentRunAfterSteer, the new run record is assigned a
    // fresh runId and startedAt while keeping the same childSessionKey as the
    // steered-away run.  If the gateway restarts before the new run has written
    // anything to the transcript, the old run's final assistant turn is still
    // the last line.  Without this boundary check we would incorrectly replay
    // stale output from the prior run instead of re-dispatching the pending task.
    //
    // The run-start boundary defaults to startedAt (set by
    // replaceSubagentRunAfterSteer) or falls back to createdAt if startedAt was
    // never set (e.g. the run was registered but never actually started).
    const runStartMs = opts?.runStartMs ?? entry.startedAt ?? entry.createdAt;
    if (lastAssistantTurnMs < runStartMs) {
      // The final assistant turn pre-dates this run's start time — it is stale
      // output from a prior run on the same session.  Re-dispatch to avoid
      // replaying the wrong result.
      return "resumable-fresh";
    }
    // The turn was written during (or after) the current run — safe to replay.
    return "resumable-replay";
  }

  // Transcript exists but does not end with a completed assistant turn.
  // This covers:
  //   • header-only / no turns at all (agent spawned but never ran)
  //   • last turn is a user/tool-result message (interrupted mid-tool-use)
  //   • last assistant turn has pending tool_use blocks (cut off mid-tool-use)
  //   • only intermediate planning / partial assistant turns present
  // In all these cases re-dispatch is safer than falsely marking the run done.
  return "resumable-fresh";
}

// ---------------------------------------------------------------------------
// Change 3a: recoverCompletedSubagentRunFromTranscript ('resumable-replay')
// ---------------------------------------------------------------------------

/**
 * Recover a run that completed while the gateway was running but whose
 * completion was never recorded in the registry.
 *
 * The transcript already contains the final assistant reply, so we directly
 * invoke `completeSubagentRun` (imported from subagent-registry) via the
 * exported `completeSubagentRunForRecover` hook rather than calling
 * `agent.wait` (which would fail because the agent process is gone).
 *
 * To avoid a circular import the actual `completeSubagentRun` call is executed
 * via the `onRecoverComplete` callback supplied by `subagent-registry.ts`.
 */
export async function recoverCompletedSubagentRunFromTranscript(
  runId: string,
  entry: SubagentRunRecord,
  onComplete: (runId: string, endedAt: number) => Promise<void>,
): Promise<void> {
  try {
    const endedAt = Date.now();
    log.info("restart recovery: replaying completed run from transcript", {
      runId,
      childSessionKey: entry.childSessionKey,
    });
    await onComplete(runId, endedAt);
  } catch (err) {
    defaultRuntime.log(
      `[warn] subagent-resume: replay recovery failed run=${runId}: ${String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Change 3b: redispatchSubagentRunAfterRestart ('resumable-fresh')
// ---------------------------------------------------------------------------

/**
 * Recover a run that never executed (empty transcript) by re-dispatching the
 * original task to the existing child session via `callGateway('agent')`.
 *
 * After the gateway restart the original `runId` is no longer tracked by the
 * gateway's in-memory run-lifecycle state, so we cannot use `agent.wait` with
 * it.  Instead we:
 *   1. Call `agent` with a fresh idempotency key → get back a new `runId`.
 *   2. Poll `agent.wait` with the new `runId`.
 *   3. Invoke `onComplete` with the original `entry.runId` so the registry
 *      entry is closed out correctly.
 *
 * @param runId          The original registry run id.
 * @param entry          The registry entry.
 * @param waitTimeoutMs  Timeout to pass to `agent.wait`.
 * @param onComplete     Callback (supplied by subagent-registry) that calls
 *                       `completeSubagentRun` for the original `runId`.
 */
export async function redispatchSubagentRunAfterRestart(
  runId: string,
  entry: SubagentRunRecord,
  waitTimeoutMs: number,
  onComplete: (runId: string, endedAt: number, outcome: { status: string }) => Promise<void>,
  suppressNotifications?: boolean,
): Promise<void> {
  // Track whether onComplete has been called so the finally block can guarantee
  // it fires on every exit path (fix for resume-lock leak on early return or
  // thrown error).
  let onCompleteCalled = false;
  const safeComplete = async (endedAt: number, outcome: { status: string }): Promise<void> => {
    if (!onCompleteCalled) {
      onCompleteCalled = true;
      await onComplete(runId, endedAt, outcome);
    }
  };

  try {
    const childSessionKey = entry.childSessionKey?.trim();
    if (!childSessionKey || !entry.task) {
      defaultRuntime.log(
        `[warn] subagent-resume: cannot redispatch run=${runId}: missing sessionKey or task`,
      );
      return;
    }

    // Notify the requester that recovery is in progress — skipped when
    // suppressNotifications is true so that the recovery path does not fire
    // user-visible chat messages before the recovered run completes.
    if (!suppressNotifications) {
      try {
        await callGateway({
          method: "chat.send",
          params: {
            sessionKey: entry.requesterSessionKey,
            message: `[gateway restart recovery] Re-dispatching subagent task after restart (run ${runId}). The previous agent process was interrupted; starting fresh in the same session.`,
            idempotencyKey: `restart-notify-${runId}`,
            deliver: false,
          },
          timeoutMs: 5_000,
        });
      } catch {
        // Best-effort notification — don't abort recovery if this fails.
      }
    }

    // Re-dispatch the original task to the child session.
    // Reconstruct the full prompt contract that was used in the original dispatch
    // (subagent-spawn.ts) so that the re-dispatched run behaves identically:
    //   • childTaskMessage — wraps the task with [Subagent Context] / [Subagent Task] headers
    //   • extraSystemPrompt — restored verbatim from the stored entry when available so that
    //     attachment-specific suffixes appended during the original spawn are preserved; only
    //     falls back to buildSubagentSystemPrompt when no stored prompt is available
    const cfg = loadConfig();
    const maxSpawnDepth =
      cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
    const childDepth = getSubagentDepthFromSessionStore(childSessionKey, { cfg });
    const childTaskMessage = [
      `[Subagent Context] You are running as a subagent (depth ${childDepth}/${maxSpawnDepth}). Results auto-announce to your requester; do not busy-poll for status.`,
      entry.spawnMode === "session"
        ? "[Subagent Context] This subagent session is persistent and remains available for thread follow-up messages."
        : undefined,
      `[Subagent Task]: ${entry.task}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");

    // Fix (comment 3): restore the original extraSystemPrompt verbatim from the
    // stored session entry so that attachment suffixes are not lost.  Fall back to
    // buildSubagentSystemPrompt only when the stored entry predates this field.
    const extraSystemPrompt =
      typeof entry.extraSystemPrompt === "string" && entry.extraSystemPrompt.trim()
        ? entry.extraSystemPrompt
        : buildSubagentSystemPrompt({
            requesterSessionKey: entry.requesterSessionKey,
            requesterOrigin: entry.requesterOrigin,
            childSessionKey,
            label: entry.label,
            task: entry.task,
            childDepth,
            maxSpawnDepth,
          });

    const redispatchIdem = crypto.randomUUID();
    // Use a fresh UUID for newRunId so it is never confused with the idempotency
    // key, which is for deduplication only and is not a valid run ID.
    let newRunId: string = crypto.randomUUID();
    try {
      log.info("restart recovery: re-dispatching task to child session", {
        runId,
        childSessionKey,
        redispatchIdem,
      });
      const response = await callGateway<{ runId?: string }>({
        method: "agent",
        params: {
          message: childTaskMessage,
          sessionKey: childSessionKey,
          idempotencyKey: redispatchIdem,
          deliver: false,
          lane: AGENT_LANE_SUBAGENT,
          timeout: entry.runTimeoutSeconds,
          extraSystemPrompt,
          // Preserve original run's depth/parent context and workspace so the
          // session tree and any relative-path file operations remain consistent
          // after restart (fix for comment 1: include workspaceDir from entry).
          spawnedBy: entry.requesterSessionKey,
          workspaceDir: entry.workspaceDir,
        },
        timeoutMs: 10_000,
      });
      if (typeof response?.runId === "string" && response.runId) {
        newRunId = response.runId;
      }
    } catch (err) {
      defaultRuntime.log(
        `[warn] subagent-resume: redispatch agent call failed run=${runId}: ${String(err)}`,
      );
      return;
    }

    // Wait for the new dispatch to complete.
    try {
      const timeoutMs = Math.max(1, Math.floor(waitTimeoutMs));
      const wait = await callGateway<{
        status?: string;
        startedAt?: number;
        endedAt?: number;
        error?: string;
      }>({
        method: "agent.wait",
        params: { runId: newRunId, timeoutMs },
        timeoutMs: timeoutMs + 10_000,
      });
      if (wait?.status !== "ok" && wait?.status !== "error" && wait?.status !== "timeout") {
        return;
      }
      const endedAt = typeof wait.endedAt === "number" ? wait.endedAt : Date.now();
      const outcome =
        wait.status === "error"
          ? {
              status: "error" as const,
              error: typeof wait.error === "string" ? wait.error : undefined,
            }
          : wait.status === "timeout"
            ? { status: "timeout" as const }
            : { status: "ok" as const };

      await safeComplete(endedAt, outcome);
    } catch (err) {
      defaultRuntime.log(
        `[warn] subagent-resume: agent.wait for redispatch failed run=${runId}: ${String(err)}`,
      );
    }
  } finally {
    // Guarantee onComplete is always called even when an early return or
    // unexpected error prevented the normal completion path from running.
    // This ensures the resume lock is never permanently leaked (fix for comment 4).
    if (!onCompleteCalled) {
      try {
        await onComplete(runId, Date.now(), { status: "error" });
      } catch (err) {
        defaultRuntime.log(
          `[warn] subagent-resume: finally-path onComplete failed run=${runId}: ${String(err)}`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inline resume routing helper (used by subagent-registry.ts)
// ---------------------------------------------------------------------------

/**
 * Route a resumed run based on its `SubagentRunResumability` classification.
 *
 * This is a convenience wrapper used by `resumeSubagentRun` in
 * `subagent-registry.ts` so that the routing logic lives here alongside the
 * resumability resolver.
 *
 * Returns `true` when this function handled the run (caller should mark it as
 * resumed and return), `false` when the caller should fall through to the
 * default `waitForSubagentCompletion` path.
 */
export function routeResumedRun(params: {
  runId: string;
  entry: SubagentRunRecord;
  waitTimeoutMs: number;
  onCompleteReplay: (runId: string, endedAt: number) => Promise<void>;
  onCompleteRedispatch: (
    runId: string,
    endedAt: number,
    outcome: { status: string },
  ) => Promise<void>;
}): boolean {
  const resumability = resolveSubagentRunResumability(params.entry);

  if (resumability === "resumable-announce-only") {
    // Already handled by the existing endedAt check in resumeSubagentRun.
    return false;
  }

  if (resumability === "orphaned") {
    // Let the caller's orphan check handle it.
    return false;
  }

  if (resumability === "resumable-replay") {
    log.info("restart recovery: resuming as replay (transcript has assistant turns)", {
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
    });
    void recoverCompletedSubagentRunFromTranscript(
      params.runId,
      params.entry,
      params.onCompleteReplay,
    );
    return true;
  }

  if (resumability === "resumable-fresh") {
    log.info("restart recovery: resuming as fresh redispatch (empty transcript)", {
      runId: params.runId,
      childSessionKey: params.entry.childSessionKey,
    });
    void redispatchSubagentRunAfterRestart(
      params.runId,
      params.entry,
      params.waitTimeoutMs,
      params.onCompleteRedispatch,
      true, // suppressNotifications — no user-visible messages before recovered run completes
    );
    return true;
  }

  return false;
}
