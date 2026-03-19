import { OVSessionBridgeClient } from "./client.js";
import type { OVSessionBridgeConfig } from "./config.js";
import { loadCheckpoint, saveCheckpoint } from "./state.js";
import { readTranscriptFile } from "./transcript.js";
import type { SessionCheckpoint } from "./types.js";

export type FlushParams = {
  openclawSessionId: string;
  sessionKey: string;
  agentId: string;
  /**
   * Absolute path to the JSONL session transcript file.
   * If undefined, the flush is a no-op (no file to read).
   */
  sessionFile?: string;
  cfg: OVSessionBridgeConfig;
  /** If true, commit the OV session at the end (triggers memory extraction). */
  isFinalFlush: boolean;
  /**
   * Optional AbortSignal to propagate cancellation into in-flight HTTP
   * requests.  When fired, all OV API calls in this flush are aborted
   * immediately rather than waiting for the per-request timeout.
   *
   * Used by flushWithTimeout: the caller-side timer calls abort() so a
   * timed-out /done actually cancels in-flight work rather than merely
   * timing out the caller while the work continues in the background.
   *
   * Note: with enqueueFlush coalescing, the signal from the *first* caller's
   * params is the one threaded into the actual HTTP work.  Subsequent callers
   * that join the in-flight promise share its result but their individual
   * signals are not retroactively threaded in — the background work is bounded
   * by cfg.timeoutMs per request and clears the mutex naturally.
   */
  signal?: AbortSignal;
};

export type FlushResult = {
  ok: boolean;
  ovSessionId?: string;
  turnsFlushed: number;
  finalized: boolean;
  skipped: boolean;
  error?: string;
};

// ── Per-session flush mutex ───────────────────────────────────────────────────
//
// Ensures at most one flush is in-flight for any given session at a time.
// A new flush request for a session that is already flushing coalesces into
// the existing promise rather than launching a second concurrent flush.
// This prevents double messages and the corruption that can follow.
//
// The map is module-level (singleton for the plugin's lifetime) which is safe
// because flushes are keyed by openclawSessionId (globally unique).
const sessionFlushMutex = new Map<string, Promise<FlushResult>>();

/**
 * Enqueue a flush for the given session.
 *
 * If a flush is already in-flight for the same sessionId, the caller joins it
 * rather than starting a duplicate.  When the in-flight flush settles it is
 * removed from the map so the next call starts a fresh flush.
 *
 * This is the preferred call site for fire-and-forget callers (e.g. session_end
 * hooks) as well as /done which needs the result.
 */
export function enqueueFlush(params: FlushParams): Promise<FlushResult> {
  const { openclawSessionId } = params;
  const inflight = sessionFlushMutex.get(openclawSessionId);
  if (inflight) return inflight;

  const p = flushSessionToOV(params);
  sessionFlushMutex.set(openclawSessionId, p);
  void p.finally(() => {
    // Clean up only if this is still the registered promise (not already replaced).
    if (sessionFlushMutex.get(openclawSessionId) === p) {
      sessionFlushMutex.delete(openclawSessionId);
    }
  });
  return p;
}

/**
 * Incrementally flush new transcript turns to OpenViking for a given session.
 * Safe to call multiple times (idempotent via checkpoint).
 *
 * Flow:
 *  1. Load checkpoint (contains ovSessionId + lastFlushedIndex).
 *  2. Read transcript file; extract normalized turns.
 *  3. Skip turns already flushed (index < lastFlushedIndex).
 *  4. If OV session doesn't exist yet, create it.
 *  5. Append delta turns to OV session — checkpoint is advanced after each
 *     successful push to prevent duplicate resends on retry.
 *  6. Update checkpoint.
 *  7. If isFinalFlush and commitOnFlush: commit OV session, mark finalized.
 *
 * NOTE: Prefer `enqueueFlush` over calling this directly. Calling this function
 * directly bypasses the per-session mutex and risks concurrent flushes.
 */
export async function flushSessionToOV(params: FlushParams): Promise<FlushResult> {
  const { openclawSessionId, sessionKey, agentId, sessionFile, cfg, isFinalFlush, signal } = params;

  // Skip entirely when plugin is disabled (caller should check, but double-guard here).
  if (!cfg.enabled) {
    return { ok: true, turnsFlushed: 0, finalized: false, skipped: true };
  }

  // Load existing checkpoint.
  const checkpoint = loadCheckpoint(cfg.stateDir, openclawSessionId);

  // Already finalized — idempotent no-op.
  if (checkpoint?.finalized) {
    return {
      ok: true,
      ovSessionId: checkpoint.ovSessionId ?? undefined,
      turnsFlushed: 0,
      finalized: true,
      skipped: true,
    };
  }

  const lastFlushedIndex = checkpoint?.lastFlushedIndex ?? 0;
  const existingOvSessionId = checkpoint?.ovSessionId ?? null;

  // Read transcript and extract new turns since last flush.
  const allTurns = sessionFile ? await readTranscriptFile(sessionFile) : [];
  const delta = allTurns.slice(lastFlushedIndex);

  // If no new content and not a final flush, skip.
  if (delta.length === 0 && !isFinalFlush) {
    return {
      ok: true,
      ovSessionId: existingOvSessionId ?? undefined,
      turnsFlushed: 0,
      finalized: false,
      skipped: true,
    };
  }

  // Pass the caller-supplied abort signal into the HTTP client so that
  // in-flight requests can be cancelled (e.g. when flushWithTimeout fires).
  const client = new OVSessionBridgeClient(
    cfg.baseUrl,
    cfg.apiKey,
    cfg.agentId,
    cfg.timeoutMs,
    signal,
  );

  let ovSessionId = existingOvSessionId;
  // Track how many turns have been successfully sent in this flush attempt.
  // Updated incrementally so the catch block can save accurate partial progress.
  let currentFlushedIndex = lastFlushedIndex;

  try {
    // Create OV session if not yet provisioned.
    if (!ovSessionId) {
      // Verify server is reachable before creating a session.
      await client.healthCheck();
      ovSessionId = await client.createSession();
      // Persist the new ovSessionId immediately so that if we crash before
      // sending any turns, we reuse the session on retry rather than leaking
      // an orphaned OV session.
      saveCheckpoint(cfg.stateDir, {
        openclawSessionId,
        sessionKey,
        agentId,
        ovSessionId,
        lastFlushedIndex: currentFlushedIndex,
        finalized: false,
        updatedAt: new Date().toISOString(),
      });
    }

    // Push delta turns one by one, advancing the checkpoint after each
    // successful send.  This means a retry after a partial failure will
    // resume from the correct offset instead of re-sending already-delivered
    // turns (which would create duplicate messages).
    for (const turn of delta) {
      await client.addSessionMessage(ovSessionId, turn.role, turn.text);
      currentFlushedIndex++;
      saveCheckpoint(cfg.stateDir, {
        openclawSessionId,
        sessionKey,
        agentId,
        ovSessionId,
        lastFlushedIndex: currentFlushedIndex,
        finalized: false,
        updatedAt: new Date().toISOString(),
      });
    }

    // Determine if we should finalize now.
    const shouldFinalize = isFinalFlush && cfg.commitOnFlush;

    if (shouldFinalize) {
      await client.commitSession(ovSessionId);
    }

    // Persist final checkpoint state.
    const updated: SessionCheckpoint = {
      openclawSessionId,
      sessionKey,
      agentId,
      ovSessionId,
      lastFlushedIndex: currentFlushedIndex,
      finalized: shouldFinalize,
      updatedAt: new Date().toISOString(),
    };
    saveCheckpoint(cfg.stateDir, updated);

    return {
      ok: true,
      ovSessionId,
      turnsFlushed: currentFlushedIndex - lastFlushedIndex,
      finalized: shouldFinalize,
      skipped: false,
    };
  } catch (err) {
    // Per-turn checkpointing above has already persisted progress for any
    // turns that were successfully sent before the error.  We only need
    // to save here if the OV session was freshly created this run and no
    // per-turn save happened yet (i.e. createSession succeeded but the
    // first addSessionMessage failed).
    if (ovSessionId && !checkpoint?.ovSessionId) {
      const reloaded = loadCheckpoint(cfg.stateDir, openclawSessionId);
      if (!reloaded?.ovSessionId) {
        // The per-session save after createSession should have handled this,
        // but guard against any edge case where it was skipped.
        try {
          saveCheckpoint(cfg.stateDir, {
            openclawSessionId,
            sessionKey,
            agentId,
            ovSessionId,
            lastFlushedIndex: currentFlushedIndex,
            finalized: false,
            updatedAt: new Date().toISOString(),
          });
        } catch {
          /* best-effort */
        }
      }
    }
    return {
      ok: false,
      ovSessionId: ovSessionId ?? undefined,
      turnsFlushed: currentFlushedIndex - lastFlushedIndex,
      finalized: false,
      skipped: false,
      error: String(err),
    };
  }
}

/**
 * Wrap a flush with a wall-clock timeout while preventing concurrent flushes
 * for the same session.
 *
 * Uses `enqueueFlush` to coalesce concurrent callers: if a flush for the given
 * session is already in-flight (e.g. fired by session_end), the caller joins it
 * rather than starting a duplicate.
 *
 * On timeout the caller receives ok:false immediately.  Cancellation is
 * propagated via an AbortController whose signal is threaded through the flush
 * params into the OV HTTP client — so in-flight HTTP requests are aborted
 * immediately rather than running to their own per-request timeout.
 *
 * Coalescing note: if a flush was already in-flight when this function is called
 * (started by another caller without an abort signal), the coalesced join shares
 * that flush's result but the abort signal is not retroactively threaded in.
 * The background work is bounded by cfg.timeoutMs per HTTP request and clears
 * the mutex naturally.  Partial-progress checkpointing is preserved in both
 * cases.
 */
export async function flushWithTimeout(
  params: FlushParams,
  timeoutMs: number,
): Promise<FlushResult> {
  const controller = new AbortController();
  // Thread the abort signal into the flush so in-flight HTTP requests are
  // actually cancelled when the timeout fires, not just the caller unblocked.
  const paramsWithSignal: FlushParams = { ...params, signal: controller.signal };
  const flushPromise = enqueueFlush(paramsWithSignal);

  return new Promise<FlushResult>((resolve) => {
    const timer = setTimeout(() => {
      controller.abort("flush timeout");
      resolve({
        ok: false,
        turnsFlushed: 0,
        finalized: false,
        skipped: false,
        error: `flush timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    flushPromise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          turnsFlushed: 0,
          finalized: false,
          skipped: false,
          error: String(err),
        });
      });
  });
}

/**
 * Flush with automatic retry and linear back-off on transient failures.
 *
 * Suitable for fire-and-forget contexts where the first attempt may fail
 * transiently (e.g. the OV server not yet available at process startup).
 * Each attempt is coalesced through the per-session mutex (enqueueFlush),
 * so concurrent callers for the same session are never doubled up.
 *
 * Returns the result of the last attempt — ok:true on any success, ok:false
 * if all attempts are exhausted.
 */
export async function flushWithRetry(
  params: FlushParams,
  opts: { maxRetries: number; retryBaseDelayMs: number },
): Promise<FlushResult> {
  let lastResult: FlushResult | null = null;

  for (let attempt = 0; attempt < opts.maxRetries; attempt++) {
    try {
      lastResult = await enqueueFlush(params);
      if (lastResult.ok || lastResult.skipped) return lastResult;
    } catch (err) {
      lastResult = {
        ok: false,
        turnsFlushed: 0,
        finalized: false,
        skipped: false,
        error: String(err),
      };
    }

    if (attempt < opts.maxRetries - 1) {
      // Linear back-off: delay grows by retryBaseDelayMs per attempt.
      await new Promise<void>((r) => setTimeout(r, opts.retryBaseDelayMs * (attempt + 1)));
    }
  }

  return (
    lastResult ?? {
      ok: false,
      turnsFlushed: 0,
      finalized: false,
      skipped: false,
      error: "no attempts made",
    }
  );
}
