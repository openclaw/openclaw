import path from "node:path";
import { updateSessionStoreEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_LANE_RESUME_CONCURRENCY = 1;
export const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

const laneResumeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleLaneAutoResume(laneId: string, delayMs: number) {
  const existing = laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => {
    laneResumeTimers.delete(laneId);
    setCommandLaneConcurrency(laneId, DEFAULT_LANE_RESUME_CONCURRENCY);
    log.info("auto-resumed lane after suspension TTL", { laneId, delayMs });
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  laneResumeTimers.set(laneId, timer);
}

export function cancelLaneAutoResume(laneId: string) {
  const existing = laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing);
    laneResumeTimers.delete(laneId);
  }
}

export async function suspendSession(params: {
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  sessionId: string;
  laneId?: string;
  reason: "quota_exhausted" | "manual" | "circuit_open";
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
}) {
  if (!params.cfg) {
    return;
  }

  const { sessionKey, storePath } = resolveStoredSessionKeyForSessionId({
    cfg: params.cfg,
    sessionId: params.sessionId,
    agentId: params.agentDir ? path.basename(params.agentDir) : undefined,
  });

  if (!sessionKey) {
    return;
  }

  const ttlMs = params.ttlMs ?? DEFAULT_QUOTA_SUSPENSION_RESUME_MS;
  const now = Date.now();

  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async () => ({
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now,
          reason: params.reason,
          failedProvider: params.failedProvider,
          failedModel: params.failedModel,
          summary: params.summary,
          laneId: params.laneId,
          expectedResumeBy: now + ttlMs,
          state: "suspended",
        },
      }),
    });
  } catch (err) {
    log.warn("failed to persist quota suspension; not throttling lane", {
      sessionId: params.sessionId,
      laneId: params.laneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (params.laneId) {
    setCommandLaneConcurrency(params.laneId, 0);
    scheduleLaneAutoResume(params.laneId, ttlMs);
  }
}
