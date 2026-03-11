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
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { defaultRuntime } from "../runtime.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
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
 * - `resumable-replay`         — transcript exists with ≥1 assistant turn and
 *   `endedAt` is unset; the run finished but its completion was never recorded
 *   in the registry.  Capture the result from the transcript and complete.
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
 * Scan `sessionsDir` for a `.jsonl` transcript that was created close to
 * `targetCreatedAtMs` (within `toleranceMs`).  Returns the absolute path of
 * the candidate if exactly one candidate is found, otherwise `null`.
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
    const now = Date.now();
    const candidates: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const fullPath = path.join(sessionsDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const fileAgeMs = now - stat.mtimeMs;
        const timeDiffMs = Math.abs(stat.mtimeMs - targetCreatedAtMs);
        if (fileAgeMs <= 60 * 60_000 && timeDiffMs <= toleranceMs) {
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
export function rehydrateSessionStoreEntries(entries: Map<string, SubagentRunRecord>): void {
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
      const sessionFile = path.relative(sessionsDir, transcriptPath);
      const synthetic: SessionEntry = {
        sessionId,
        updatedAt: targetCreatedAtMs,
        sessionFile,
        spawnedBy: entry.requesterSessionKey,
        spawnDepth: 1,
      };

      // Re-read, mutate, write back — keep it simple for Phase 1.
      // We write with a direct synchronous fs call to stay compatible with the
      // synchronous `restoreSubagentRunsOnce` call path.
      const freshStore = loadSessionStore(storePath, { skipCache: true });
      const normalizedKey = childSessionKey.toLowerCase();
      if (!findEntryByKey(freshStore, childSessionKey)) {
        freshStore[normalizedKey] = synthetic;
        try {
          fs.mkdirSync(path.dirname(storePath), { recursive: true });
          const serialized = JSON.stringify(freshStore, null, 2);
          fs.writeFileSync(storePath, `${serialized}\n`, { mode: 0o600 });
          log.info("rehydrated session store entry", { childSessionKey, sessionId });
        } catch (writeErr) {
          log.debug("rehydrate: session-store write failed", {
            childSessionKey,
            error: String(writeErr),
          });
        }
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
  opts?: { transcriptPath?: string },
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
    }
  } catch {
    // Best-effort — treat as if session store is missing.
  }

  if (!sessionId) {
    // No session-store entry even after rehydration → orphaned.
    return "orphaned";
  }

  // ③ Resolve transcript path.
  let transcriptPath: string;
  if (opts?.transcriptPath) {
    transcriptPath = opts.transcriptPath;
  } else {
    try {
      const cfg = loadConfig();
      const agentId = resolveAgentIdFromSessionKey(childSessionKey);
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const sessionsDir = path.dirname(storePath);
      transcriptPath = path.join(sessionsDir, `${sessionId}.jsonl`);
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

  if (transcriptHasAssistantTurn(transcriptPath)) {
    // The agent ran and produced output — we just need to capture and announce.
    return "resumable-replay";
  }

  // Transcript exists but has no assistant turns → agent was spawned, wrote
  // the session header, but never completed a turn.  Re-dispatch.
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
): Promise<void> {
  const childSessionKey = entry.childSessionKey?.trim();
  if (!childSessionKey || !entry.task) {
    defaultRuntime.log(
      `[warn] subagent-resume: cannot redispatch run=${runId}: missing sessionKey or task`,
    );
    return;
  }

  // Notify the requester that recovery is in progress.
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

  // Re-dispatch the original task to the child session.
  const redispatchIdem = crypto.randomUUID();
  let newRunId: string = redispatchIdem;
  try {
    log.info("restart recovery: re-dispatching task to child session", {
      runId,
      childSessionKey,
      redispatchIdem,
    });
    const response = await callGateway<{ runId?: string }>({
      method: "agent",
      params: {
        message: entry.task,
        sessionKey: childSessionKey,
        idempotencyKey: redispatchIdem,
        deliver: false,
        lane: AGENT_LANE_SUBAGENT,
        timeout: entry.runTimeoutSeconds,
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

    await onComplete(runId, endedAt, outcome);
  } catch (err) {
    defaultRuntime.log(
      `[warn] subagent-resume: agent.wait for redispatch failed run=${runId}: ${String(err)}`,
    );
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
    );
    return true;
  }

  return false;
}
