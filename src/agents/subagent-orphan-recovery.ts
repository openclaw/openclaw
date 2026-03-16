/**
 * Post-restart orphan recovery for subagent sessions.
 *
 * After a SIGUSR1 gateway reload aborts in-flight subagent LLM calls,
 * this module scans for orphaned sessions (those with `abortedLastRun: true`
 * that are still tracked as active in the subagent registry) and sends a
 * synthetic resume message to restart their work.
 *
 * @see https://github.com/openclaw/openclaw/issues/47711
 */

import crypto from "node:crypto";
import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
  updateSessionStore,
  type SessionEntry,
} from "../config/sessions.js";
import { callGateway } from "../gateway/call.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const log = createSubsystemLogger("subagent-orphan-recovery");

/** Delay before attempting recovery to let the gateway finish bootstrapping. */
const DEFAULT_RECOVERY_DELAY_MS = 5_000;

/**
 * Build the resume message for an orphaned subagent.
 */
function buildResumeMessage(task: string): string {
  const maxTaskLen = 2000;
  const truncatedTask = task.length > maxTaskLen ? `${task.slice(0, maxTaskLen)}...` : task;

  return (
    `[System] Your previous turn was interrupted by a gateway reload. ` +
    `Your task was:\n\n${truncatedTask}\n\nPlease continue where you left off.`
  );
}

/**
 * Send a resume message to an orphaned subagent session via the gateway agent method.
 */
async function resumeOrphanedSession(params: {
  sessionKey: string;
  task: string;
}): Promise<boolean> {
  const resumeMessage = buildResumeMessage(params.task);

  try {
    await callGateway<{ runId: string }>({
      method: "agent",
      params: {
        message: resumeMessage,
        sessionKey: params.sessionKey,
        idempotencyKey: crypto.randomUUID(),
        deliver: false,
        lane: "subagent",
      },
      timeoutMs: 10_000,
    });
    log.info(`resumed orphaned session: ${params.sessionKey}`);
    return true;
  } catch (err) {
    log.warn(`failed to resume orphaned session ${params.sessionKey}: ${String(err)}`);
    return false;
  }
}

/**
 * Scan for and resume orphaned subagent sessions after a gateway restart.
 *
 * An orphaned session is one where:
 * 1. It has an active (not ended) entry in the subagent run registry
 * 2. Its session store entry has `abortedLastRun: true`
 *
 * For each orphaned session found, we:
 * 1. Clear the `abortedLastRun` flag
 * 2. Send a synthetic resume message to trigger a new LLM turn
 */
export async function recoverOrphanedSubagentSessions(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const result = { recovered: 0, failed: 0, skipped: 0 };

  try {
    const activeRuns = params.getActiveRuns();
    if (activeRuns.size === 0) {
      return result;
    }

    const cfg = loadConfig();
    const storeCache = new Map<string, Record<string, SessionEntry>>();

    for (const [runId, runRecord] of activeRuns.entries()) {
      // Only consider runs that haven't ended yet
      if (typeof runRecord.endedAt === "number" && runRecord.endedAt > 0) {
        continue;
      }

      const childSessionKey = runRecord.childSessionKey?.trim();
      if (!childSessionKey) {
        continue;
      }

      try {
        const agentId = resolveAgentIdFromSessionKey(childSessionKey);
        const storePath = resolveStorePath(cfg.session?.store, { agentId });

        let store = storeCache.get(storePath);
        if (!store) {
          store = loadSessionStore(storePath);
          storeCache.set(storePath, store);
        }

        const entry = store[childSessionKey];
        if (!entry) {
          result.skipped++;
          continue;
        }

        // Check if this session was aborted by the restart
        if (!entry.abortedLastRun) {
          result.skipped++;
          continue;
        }

        log.info(`found orphaned subagent session: ${childSessionKey} (run=${runId})`);

        // Clear the aborted flag before resuming
        await updateSessionStore(storePath, (currentStore) => {
          const current = currentStore[childSessionKey];
          if (current) {
            current.abortedLastRun = false;
            current.updatedAt = Date.now();
            currentStore[childSessionKey] = current;
          }
        });

        // Resume the session with the original task context
        const resumed = await resumeOrphanedSession({
          sessionKey: childSessionKey,
          task: runRecord.task,
        });

        if (resumed) {
          result.recovered++;
        } else {
          result.failed++;
        }
      } catch (err) {
        log.warn(`error processing orphaned session ${childSessionKey}: ${String(err)}`);
        result.failed++;
      }
    }
  } catch (err) {
    log.warn(`orphan recovery scan failed: ${String(err)}`);
  }

  if (result.recovered > 0 || result.failed > 0) {
    log.info(
      `orphan recovery complete: recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    );
  }

  return result;
}

/**
 * Schedule orphan recovery after a delay.
 * The delay gives the gateway time to fully bootstrap after restart.
 */
export function scheduleOrphanRecovery(params: {
  getActiveRuns: () => Map<string, SubagentRunRecord>;
  delayMs?: number;
}): void {
  const delay = params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS;
  setTimeout(() => {
    void recoverOrphanedSubagentSessions(params).catch((err) => {
      log.warn(`scheduled orphan recovery failed: ${String(err)}`);
    });
  }, delay).unref?.();
}
