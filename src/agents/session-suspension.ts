/**
 * Session suspension and lane auto-resume helpers.
 *
 * Records quota/manual/circuit suspensions and temporarily lowers command-lane concurrency.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import { resolveCronMaxConcurrentRuns } from "../config/cron-limits.js";
import { patchSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "../shared/number-coercion.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import type { FailoverReason } from "./embedded-agent-helpers/types.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY = 1;
const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

type LaneResumeTimer = {
  timer: ReturnType<typeof setTimeout>;
  resumeConcurrency: number;
};

type SessionSuspensionRuntimeState = {
  laneResumeTimers: Map<string, LaneResumeTimer>;
  clearedLaneResumes: Map<string, number>;
  cleanupGeneration: number;
  cleanupActive: boolean;
};

/**
 * Keep timer shutdown state process-global so bundled gateway chunks cannot
 * leave one module copy scheduling lane resumes after another copy cleaned up.
 */
const SESSION_SUSPENSION_STATE_KEY = Symbol.for("openclaw.sessionSuspensionRuntimeState");

function getSessionSuspensionState(): SessionSuspensionRuntimeState {
  const state = resolveGlobalSingleton<SessionSuspensionRuntimeState>(
    SESSION_SUSPENSION_STATE_KEY,
    () => ({
      laneResumeTimers: new Map<string, LaneResumeTimer>(),
      clearedLaneResumes: new Map<string, number>(),
      cleanupGeneration: 0,
      cleanupActive: false,
    }),
  );
  if (!state.clearedLaneResumes) {
    state.clearedLaneResumes = new Map<string, number>();
  }
  return state;
}

const deferredSessionSuspension = new AsyncLocalStorage<{
  claimed: boolean;
  onDeferred?: (params: SessionSuspensionParams) => void;
}>();

export type SessionSuspensionReason = "quota_exhausted" | "manual" | "circuit_open";
type SessionSuspensionTarget =
  | { mode: "defer"; defer: (params: SessionSuspensionParams) => void }
  | { mode: "suspend" };
export type SessionSuspensionParams = {
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  sessionId: string;
  laneId?: string;
  reason: SessionSuspensionReason;
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
};

function resolveLaneResumeConcurrency(cfg: OpenClawConfig | undefined, laneId: string): number {
  switch (laneId) {
    case "main":
      return resolveAgentMaxConcurrent(cfg);
    case "subagent":
      return resolveSubagentMaxConcurrent(cfg);
    case "cron":
    case "cron-nested":
      return resolveCronMaxConcurrentRuns(cfg?.cron);
    default:
      return DEFAULT_CUSTOM_LANE_RESUME_CONCURRENCY;
  }
}

export function resolveSessionSuspensionReason(reason: FailoverReason): SessionSuspensionReason {
  if (reason === "billing") {
    return "manual";
  }
  if (reason === "rate_limit") {
    return "quota_exhausted";
  }
  return "circuit_open";
}

export function runWithDeferredSessionSuspension<T>(
  run: () => Promise<T>,
  onDeferred?: (params: SessionSuspensionParams) => void,
): Promise<T> {
  return deferredSessionSuspension.run({ claimed: false, onDeferred }, run);
}

export function resolveSessionSuspensionTarget(): SessionSuspensionTarget {
  const scope = deferredSessionSuspension.getStore();
  if (!scope || scope.claimed) {
    return { mode: "suspend" };
  }
  // One candidate callback may launch nested direct embedded runs. Only its
  // first embedded run inherits the outer fallback's remaining-candidate fact.
  scope.claimed = true;
  return { mode: "defer", defer: (params) => scope.onDeferred?.(params) };
}

function scheduleLaneAutoResume(laneId: string, delayMs: number, resumeConcurrency: number) {
  const state = getSessionSuspensionState();
  const existing = state.laneResumeTimers.get(laneId);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    if (state.laneResumeTimers.get(laneId)?.timer === timer) {
      state.laneResumeTimers.delete(laneId);
    }
    setCommandLaneConcurrency(laneId, resumeConcurrency);
    log.info("auto-resumed lane after suspension TTL", {
      laneId,
      delayMs,
      resumeConcurrency,
    });
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  state.laneResumeTimers.set(laneId, { timer, resumeConcurrency });
}

export function clearSessionSuspensionTimers(): number {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = true;
  let cleared = 0;
  for (const [laneId, entry] of state.laneResumeTimers) {
    clearTimeout(entry.timer);
    state.clearedLaneResumes.set(laneId, entry.resumeConcurrency);
    cleared += 1;
  }
  state.laneResumeTimers.clear();
  return cleared;
}

export function enableSessionSuspensionTimersForGatewayStart(): number {
  const state = getSessionSuspensionState();
  state.cleanupGeneration += 1;
  state.cleanupActive = false;
  let restored = 0;
  for (const [laneId, resumeConcurrency] of state.clearedLaneResumes) {
    setCommandLaneConcurrency(laneId, resumeConcurrency);
    restored += 1;
  }
  state.clearedLaneResumes.clear();
  return restored;
}

export async function suspendSession(params: SessionSuspensionParams) {
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

  const ttlMs = resolveTimerTimeoutMs(params.ttlMs, DEFAULT_QUOTA_SUSPENSION_RESUME_MS, 0);
  const now = Date.now();
  const expectedResumeBy = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) ?? now;
  const state = getSessionSuspensionState();
  const suspensionGeneration = state.cleanupGeneration;

  try {
    await patchSessionEntry(
      { storePath, sessionKey },
      () => ({
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now,
          reason: params.reason,
          failedProvider: params.failedProvider,
          failedModel: params.failedModel,
          summary: params.summary,
          laneId: params.laneId,
          expectedResumeBy,
          state: "suspended",
        },
      }),
      { skipMaintenance: true, takeCacheOwnership: true },
    );
  } catch (err) {
    log.warn("failed to persist quota suspension; not throttling lane", {
      sessionId: params.sessionId,
      laneId: params.laneId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const postPatchState = getSessionSuspensionState();
  if (postPatchState.cleanupActive || suspensionGeneration !== postPatchState.cleanupGeneration) {
    try {
      await patchSessionEntry(
        { storePath, sessionKey },
        (entry) =>
          entry.quotaSuspension?.suspendedAt === now &&
          entry.quotaSuspension.reason === params.reason &&
          entry.quotaSuspension.failedProvider === params.failedProvider &&
          entry.quotaSuspension.failedModel === params.failedModel &&
          entry.quotaSuspension.laneId === params.laneId
            ? { quotaSuspension: undefined }
            : null,
        {
          skipMaintenance: true,
          takeCacheOwnership: true,
        },
      );
    } catch (err) {
      log.warn("failed to clear quota suspension after shutdown cleanup", {
        sessionId: params.sessionId,
        laneId: params.laneId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (params.laneId) {
    setCommandLaneConcurrency(params.laneId, 0);
    scheduleLaneAutoResume(
      params.laneId,
      ttlMs,
      resolveLaneResumeConcurrency(params.cfg, params.laneId),
    );
  }
}

export const testing = {
  resetSessionSuspensionStateForTest: () => {
    const state = getSessionSuspensionState();
    for (const entry of state.laneResumeTimers.values()) {
      clearTimeout(entry.timer);
    }
    state.laneResumeTimers.clear();
    state.clearedLaneResumes.clear();
    state.cleanupGeneration = 0;
    state.cleanupActive = false;
  },
  resolveLaneResumeConcurrency,
  resolveSessionSuspensionReason,
} as const;
