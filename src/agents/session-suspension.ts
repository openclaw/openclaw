import { AsyncLocalStorage } from "node:async_hooks";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { QuotaSuspension } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveRegisteredAgentIdForDir } from "./agent-dir-registry.js";
import { resolveStoredSessionKeyForSessionId } from "./command/session.js";
import type { FailoverReason } from "./failover/signal.js";

const log = createSubsystemLogger("session-suspension");

const DEFAULT_QUOTA_SUSPENSION_RESUME_MS = 30 * 60 * 1000; // 30 min

type SessionSuspensionRuntimeState = {
  suspensionWriteChain: Promise<void>;
  cleanupActive: boolean;
};

/** Bundled Gateway chunks share serialization and shutdown admission. */
const suspensionState = resolveGlobalSingleton<SessionSuspensionRuntimeState>(
  Symbol.for("openclaw.sessionSuspensionRuntimeState"),
  () => ({
    suspensionWriteChain: Promise.resolve(),
    cleanupActive: false,
  }),
);

const deferredSessionSuspension = new AsyncLocalStorage<{
  claimed: boolean;
  onDeferred?: (params: SessionSuspensionParams) => void;
}>();

type SessionSuspensionReason = "quota_exhausted" | "manual" | "circuit_open";
export type SessionSuspensionParams = {
  cfg: OpenClawConfig | undefined;
  agentId?: string;
  agentDir?: string;
  sessionId: string;
  reason: SessionSuspensionReason;
  failedProvider: string;
  failedModel: string;
  summary?: string;
  ttlMs?: number;
};

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

export function captureSessionSuspension(): (params: SessionSuspensionParams) => void {
  const scope = deferredSessionSuspension.getStore();
  if (!scope || scope.claimed) {
    return (params) => {
      void suspendSession(params);
    };
  }
  // One candidate callback may launch nested direct embedded runs. Only its
  // first embedded run inherits the outer fallback's remaining-candidate fact.
  scope.claimed = true;
  return (params) => scope.onDeferred?.(params);
}

export function fenceSessionSuspensionWritesForGatewayShutdown(): void {
  suspensionState.cleanupActive = true;
}

export function enableSessionSuspensionWritesForGatewayStart(): void {
  suspensionState.cleanupActive = false;
}

export async function suspendSession(params: SessionSuspensionParams) {
  const state = suspensionState;
  const run = state.suspensionWriteChain
    .then(() => suspendSessionQueued(params))
    .catch((err: unknown) => {
      log.warn("failed to persist quota suspension", {
        sessionId: params.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  // Complete each accepted marker write before the next one begins.
  state.suspensionWriteChain = run;
  await run;
}

async function suspendSessionQueued(params: SessionSuspensionParams) {
  if (!params.cfg) {
    return;
  }

  // agentDir is <state>/agents/<id>/agent, so basename(agentDir) is always the
  // literal "agent" — only the registry lookup recovers the real owner id.
  const agentIdFromDir = params.agentDir
    ? resolveRegisteredAgentIdForDir(params.agentDir)
    : undefined;
  const { sessionKey, storePath } = await resolveStoredSessionKeyForSessionId({
    cfg: params.cfg,
    sessionId: params.sessionId,
    agentId: params.agentId ?? agentIdFromDir,
  });

  if (!sessionKey) {
    return;
  }

  const ttlMs = resolveTimerTimeoutMs(params.ttlMs, DEFAULT_QUOTA_SUSPENSION_RESUME_MS, 0);
  const now = Date.now();
  const expectedResumeBy = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: now }) ?? now;
  const state = suspensionState;
  if (state.cleanupActive) {
    return;
  }
  // A committed diagnostic marker may survive a crossing restart; its TTL owns recovery.
  await patchSessionEntryCore(
    { storePath, sessionKey },
    () => {
      if (state.cleanupActive) {
        return null;
      }
      return {
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now,
          reason: params.reason,
          failedProvider: params.failedProvider,
          failedModel: params.failedModel,
          summary: params.summary,
          expectedResumeBy,
          state: "suspended",
        } satisfies QuotaSuspension,
      };
    },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}

function resetSessionSuspensionStateForTest(): void {
  const state = suspensionState;
  state.suspensionWriteChain = Promise.resolve();
  state.cleanupActive = false;
}

function isSessionSuspensionWriteCleanupActiveForTest(): boolean {
  return suspensionState.cleanupActive;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.sessionSuspensionTestApi")] = {
    isSessionSuspensionWriteCleanupActiveForTest,
    resetSessionSuspensionStateForTest,
  };
}
