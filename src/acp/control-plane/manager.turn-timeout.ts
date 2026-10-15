import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { clampTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { settlesWithin } from "../../shared/settle-within.js";
import { AcpRuntimeError } from "../runtime/errors.js";
import type { ActiveTurnState, SessionAcpMeta } from "./manager.types.js";
import { resolveRuntimeOptionsFromMeta } from "./runtime-options.js";

const ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS = 2_000;
const ACP_TURN_TIMEOUT_REASON = "turn-timeout";
export const ACP_TURN_TIMEOUT_DETAIL_CODE = "TURN_TIMEOUT";

export function resolveTurnTimeoutMs(params: {
  cfg: OpenClawConfig;
  meta: SessionAcpMeta;
}): number {
  const runtimeTimeoutSeconds = resolveRuntimeOptionsFromMeta(params.meta).timeoutSeconds;
  if (runtimeTimeoutSeconds !== undefined) {
    return clampTimerTimeoutMs(runtimeTimeoutSeconds * 1_000, 1_000) ?? 1_000;
  }
  return resolveAgentTimeoutMs({
    cfg: params.cfg,
    minMs: 1_000,
  });
}

export async function awaitTurnWithTimeout<T>(params: {
  sessionKey: string;
  turnPromise: Promise<T>;
  timeoutMs: number;
  timeoutLabelMs: number;
  onTimeout: () => Promise<void>;
}): Promise<T> {
  const timeoutMs = params.timeoutMs <= 0 ? undefined : clampTimerTimeoutMs(params.timeoutMs, 1);
  if (timeoutMs !== undefined && !(await settlesWithin(params.turnPromise, timeoutMs))) {
    void params.turnPromise.catch((error: unknown) => {
      logVerbose(
        `acp-manager: detached late turn error after timeout for ${params.sessionKey}: ${String(error)}`,
      );
    });
    await params.onTimeout();
    throw new AcpRuntimeError(
      "ACP_TURN_FAILED",
      `ACP turn timed out after ${Math.max(1, Math.round(params.timeoutLabelMs / 1_000))}s.`,
      { detailCode: ACP_TURN_TIMEOUT_DETAIL_CODE },
    );
  }
  return await params.turnPromise;
}

export async function cleanupTimedOutTurn(params: {
  sessionKey: string;
  activeTurn: ActiveTurnState;
  mode: AcpRuntimeSessionMode;
  clearCachedRuntimeStateIfHandleMatches: (activeTurn: ActiveTurnState) => void;
}): Promise<void> {
  params.activeTurn.abortController.abort();
  if (!params.activeTurn.cancelPromise) {
    params.activeTurn.cancelPromise = params.activeTurn.runtime.cancel({
      handle: params.activeTurn.handle,
      reason: ACP_TURN_TIMEOUT_REASON,
    });
  }
  const cancelFinished = await awaitCleanupWithGrace({
    sessionKey: params.sessionKey,
    label: "cancel",
    promise: params.activeTurn.cancelPromise,
  });
  if (params.mode !== "oneshot") {
    return;
  }
  const closePromise = params.activeTurn.runtime.close({
    handle: params.activeTurn.handle,
    reason: ACP_TURN_TIMEOUT_REASON,
  });
  const closeFinished = await awaitCleanupWithGrace({
    sessionKey: params.sessionKey,
    label: "close",
    promise: closePromise,
  });
  if (cancelFinished && closeFinished) {
    params.clearCachedRuntimeStateIfHandleMatches(params.activeTurn);
    return;
  }
  void Promise.allSettled([params.activeTurn.cancelPromise, closePromise]).then(() => {
    params.clearCachedRuntimeStateIfHandleMatches(params.activeTurn);
  });
}

async function awaitCleanupWithGrace(params: {
  sessionKey: string;
  label: "cancel" | "close";
  promise: Promise<unknown>;
}): Promise<boolean> {
  const observedCleanupPromise = params.promise.then(
    () => ({
      kind: "done" as const,
    }),
    (error: unknown) => ({
      kind: "error" as const,
      error,
    }),
  );
  if (!(await settlesWithin(observedCleanupPromise, ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS))) {
    void observedCleanupPromise.then((lateOutcome) => {
      if (lateOutcome.kind === "error") {
        logVerbose(
          `acp-manager: detached timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(lateOutcome.error)}`,
        );
      }
    });
    logVerbose(
      `acp-manager: timed-out turn ${params.label} cleanup exceeded ${ACP_TURN_TIMEOUT_CLEANUP_GRACE_MS}ms for ${params.sessionKey}`,
    );
    return false;
  }
  const outcome = await observedCleanupPromise;
  if (outcome.kind === "error") {
    logVerbose(
      `acp-manager: timed-out turn ${params.label} cleanup failed for ${params.sessionKey}: ${String(outcome.error)}`,
    );
  }
  return true;
}
