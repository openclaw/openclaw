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
};

export type FlushResult = {
  ok: boolean;
  ovSessionId?: string;
  turnsFlushed: number;
  finalized: boolean;
  skipped: boolean;
  error?: string;
};

/**
 * Incrementally flush new transcript turns to OpenViking for a given session.
 * Safe to call multiple times (idempotent via checkpoint).
 *
 * Flow:
 *  1. Load checkpoint (contains ovSessionId + lastFlushedIndex).
 *  2. Read transcript file; extract normalized turns.
 *  3. Skip turns already flushed (index < lastFlushedIndex).
 *  4. If OV session doesn't exist yet, create it.
 *  5. Append delta turns to OV session.
 *  6. Update checkpoint.
 *  7. If isFinalFlush and commitOnFlush: commit OV session, mark finalized.
 */
export async function flushSessionToOV(params: FlushParams): Promise<FlushResult> {
  const { openclawSessionId, sessionKey, agentId, sessionFile, cfg, isFinalFlush } = params;

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

  const client = new OVSessionBridgeClient(cfg.baseUrl, cfg.apiKey, cfg.agentId, cfg.timeoutMs);

  let ovSessionId = existingOvSessionId;
  try {
    // Create OV session if not yet provisioned.
    if (!ovSessionId) {
      // Verify server is reachable before creating a session.
      await client.healthCheck();
      ovSessionId = await client.createSession();
    }

    // Push delta turns.
    for (const turn of delta) {
      await client.addSessionMessage(ovSessionId, turn.role, turn.text);
    }

    const newLastFlushedIndex = lastFlushedIndex + delta.length;

    // Determine if we should finalize now.
    const shouldFinalize = isFinalFlush && cfg.commitOnFlush;

    if (shouldFinalize) {
      await client.commitSession(ovSessionId);
    }

    // Persist updated checkpoint.
    const updated: SessionCheckpoint = {
      openclawSessionId,
      sessionKey,
      agentId,
      ovSessionId,
      lastFlushedIndex: newLastFlushedIndex,
      finalized: shouldFinalize,
      updatedAt: new Date().toISOString(),
    };
    saveCheckpoint(cfg.stateDir, updated);

    return {
      ok: true,
      ovSessionId,
      turnsFlushed: delta.length,
      finalized: shouldFinalize,
      skipped: false,
    };
  } catch (err) {
    // Save partial progress so a retry resumes from the right offset.
    if (ovSessionId && delta.length > 0) {
      // We might have sent some turns; can't know exactly how many without tracking per-turn.
      // Conservative: don't advance lastFlushedIndex on error so we retry from the same point.
    }
    // Persist provisional ovSessionId even on failure so we reuse the session next time.
    if (ovSessionId && !checkpoint?.ovSessionId) {
      const partial: SessionCheckpoint = {
        openclawSessionId,
        sessionKey,
        agentId,
        ovSessionId,
        lastFlushedIndex: checkpoint?.lastFlushedIndex ?? 0,
        finalized: false,
        updatedAt: new Date().toISOString(),
      };
      try {
        saveCheckpoint(cfg.stateDir, partial);
      } catch {
        /* best-effort */
      }
    }
    return {
      ok: false,
      ovSessionId: ovSessionId ?? undefined,
      turnsFlushed: 0,
      finalized: false,
      skipped: false,
      error: String(err),
    };
  }
}

/**
 * Wrap flushSessionToOV with a wall-clock timeout.
 * On timeout, resolves with ok:false so callers can decide whether to block.
 */
export async function flushWithTimeout(
  params: FlushParams,
  timeoutMs: number,
): Promise<FlushResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        ok: false,
        turnsFlushed: 0,
        finalized: false,
        skipped: false,
        error: `flush timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    flushSessionToOV(params)
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
