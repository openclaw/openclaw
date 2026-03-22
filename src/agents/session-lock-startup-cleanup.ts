/**
 * Startup cleanup for stale session lock files.
 *
 * After a gateway restart (especially SIGUSR1), lock files from the old process
 * become stale — they reference dead PIDs. This module scans for and removes
 * such stale locks on gateway startup.
 *
 * @see https://github.com/openclaw/openclaw/issues/52289
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { cleanStaleLockFiles } from "./session-write-lock.js";

const log = createSubsystemLogger("session-lock-startup-cleanup");

/** Delay before cleanup to let the gateway finish bootstrapping. */
const DEFAULT_CLEANUP_DELAY_MS = 2_000;

/** Default threshold for considering a lock stale (30 minutes). */
const DEFAULT_STALE_MS = 30 * 60 * 1000;

/**
 * Scan all agent sessions directories and clean stale lock files.
 */
async function cleanAllAgentSessionLocks(params: {
  staleMs?: number;
  log?: { warn?: (msg: string) => void; info?: (msg: string) => void };
}): Promise<{ totalCleaned: number; agentsCleaned: string[] }> {
  const stateDir = resolveStateDir();
  const agentsDir = path.join(stateDir, "agents");
  const staleMs = params.staleMs ?? DEFAULT_STALE_MS;

  let entries: Awaited<ReturnType<typeof fs.readdir>> = [];
  try {
    entries = await fs.readdir(agentsDir, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { totalCleaned: 0, agentsCleaned: [] };
    }
    throw err;
  }

  let totalCleaned = 0;
  const agentsCleaned: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const agentId = entry.name;
    const sessionsDir = path.join(agentsDir, agentId, "sessions");

    try {
      const result = await cleanStaleLockFiles({
        sessionsDir,
        staleMs,
        removeStale: true,
        log: params.log,
      });

      if (result.cleaned.length > 0) {
        totalCleaned += result.cleaned.length;
        agentsCleaned.push(agentId);
      }
    } catch (err) {
      // Skip agents whose sessions directory doesn't exist or is inaccessible
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT" && code !== "EACCES") {
        log.warn(`failed to clean locks for agent ${String(agentId)}: ${String(err)}`);
      }
    }
  }

  return { totalCleaned, agentsCleaned };
}

/**
 * Schedule stale lock cleanup after gateway startup.
 * Runs after a short delay to avoid interfering with critical startup tasks.
 */
export function scheduleStartupLockCleanup(params?: { delayMs?: number; staleMs?: number }): void {
  const delayMs = params?.delayMs ?? DEFAULT_CLEANUP_DELAY_MS;
  const staleMs = params?.staleMs ?? DEFAULT_STALE_MS;

  setTimeout(() => {
    void cleanAllAgentSessionLocks({
      staleMs,
      log: {
        warn: (msg) => log.warn(msg),
        info: (msg) => log.info(msg),
      },
    })
      .then((result) => {
        if (result.totalCleaned > 0) {
          log.info(
            `startup cleanup: removed ${result.totalCleaned} stale lock file(s) ` +
              `from ${result.agentsCleaned.length} agent(s)`,
          );
        }
      })
      .catch((err) => {
        log.warn(`startup lock cleanup failed: ${String(err)}`);
      });
  }, delayMs).unref?.();
}

export const __testing = {
  cleanAllAgentSessionLocks,
};
