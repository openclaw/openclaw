import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { mergeRestartRecoveryTerminalRunIds } from "../../config/sessions/restart-recovery-state.js";
import { retryAsync } from "../../infra/retry.js";
import { isAgentLifecycleYieldedWaiting } from "../agent-lifecycle-parent-state.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import { resolveAgentRunErrorLifecycleFields } from "../run-termination.js";
import {
  buildMainSessionRecoveryClearPatch,
  removeMainSessionRecoveryForegroundClaim,
  type MainRecoveryStateFields,
} from "./main-session-recovery-clear.js";

const MAIN_SESSION_RECOVERY_RETRY_DELAY_MS = 1_000;
const MAIN_SESSION_RECOVERY_RETRY_MAX_DELAY_MS = 30_000;

type MainRecoveryLifecycleEvent = {
  runId?: string;
  lifecycleGeneration?: string;
  data?: Parameters<typeof isAgentLifecycleYieldedWaiting>[0];
};

export async function retryMainSessionRecoveryMutation<T>(mutation: () => Promise<T>): Promise<T> {
  return await retryAsync(mutation, 3, 25);
}

/** Retries now, then leaves an exact idempotent repair queued after transient failure. */
export async function repairMainSessionRecoveryMutation<T>(params: {
  mutation: () => Promise<T>;
  onDeferredSuccess: (result: T) => void | Promise<void>;
  onError: (error: unknown) => void;
}): Promise<T | undefined> {
  try {
    return await retryMainSessionRecoveryMutation(params.mutation);
  } catch (error) {
    params.onError(error);
    scheduleMainSessionRecoveryMutation({
      mutation: () => retryMainSessionRecoveryMutation(params.mutation),
      onSuccess: params.onDeferredSuccess,
    });
    return undefined;
  }
}

/** Keeps an idempotent durable-state repair alive until it succeeds or restart retires it. */
export function scheduleMainSessionRecoveryMutation<T>(params: {
  mutation: () => Promise<T>;
  onError?: (error: unknown) => void;
  onSuccess: (result: T) => void | Promise<void>;
  delayMs?: number;
}): void {
  const delayMs = params.delayMs ?? MAIN_SESSION_RECOVERY_RETRY_DELAY_MS;
  setTimeout(() => {
    void params.mutation().then(params.onSuccess, (error: unknown) => {
      params.onError?.(error);
      scheduleMainSessionRecoveryMutation({
        ...params,
        delayMs: Math.min(delayMs * 2, MAIN_SESSION_RECOVERY_RETRY_MAX_DELAY_MS),
      });
    });
  }, delayMs).unref?.();
}

export function inspectMainSessionRecoveryLifecycleEvent(params: {
  currentLifecycleGeneration: string;
  entry?: Partial<Pick<SessionEntry, "restartRecoveryRuns">> | null;
  event: MainRecoveryLifecycleEvent;
  abortSignal?: AbortSignal;
}) {
  const runId = params.event.runId?.trim();
  const lifecycleGeneration = params.event.lifecycleGeneration?.trim();
  const phase = params.event.data?.phase;
  const terminal =
    phase === "end" || phase === "error"
      ? buildAgentRunTerminalOutcomeFromLifecycleEvent({
          phase,
          data: {
            ...params.event.data,
            ...resolveAgentRunErrorLifecycleFields(params.event.data?.error, params.abortSignal),
          },
        })
      : undefined;
  const matchesFence = Boolean(
    runId &&
    lifecycleGeneration &&
    params.entry?.restartRecoveryRuns?.some(
      (run) => run.runId === runId && run.lifecycleGeneration === lifecycleGeneration,
    ),
  );
  const interrupted = terminal?.reason === "cancelled" && terminal.stopReason === "restart";
  return {
    runId,
    lifecycleGeneration,
    terminal,
    matchesFence,
    interrupted,
    suppress:
      matchesFence &&
      (phase === "start" ||
        (interrupted && lifecycleGeneration !== params.currentLifecycleGeneration)),
  };
}

function settleForegroundOwner(
  entry: MainRecoveryStateFields,
  runId: string,
  lifecycleGeneration: string,
  currentLifecycleGeneration: string,
) {
  const state = entry.mainRestartRecovery;
  const claims = state?.foregroundClaims;
  const claimId =
    lifecycleGeneration === currentLifecycleGeneration &&
    claims?.lifecycleGeneration === lifecycleGeneration
      ? claims.tokens.find((token) => claims.runIdsByClaimId?.[token] === runId)
      : undefined;
  if (!state || !claims || !claimId) {
    return {
      hasCurrentOwner:
        Boolean(
          claims?.lifecycleGeneration === currentLifecycleGeneration && claims.tokens.length,
        ) || state?.reservation?.lifecycleGeneration === currentLifecycleGeneration,
    };
  }
  const foregroundClaims = removeMainSessionRecoveryForegroundClaim(claims, claimId);
  return {
    claimId,
    state: { ...state, revision: state.revision + 1, foregroundClaims },
    hasCurrentOwner:
      Boolean(foregroundClaims) ||
      state.reservation?.lifecycleGeneration === currentLifecycleGeneration,
  };
}

export function projectMainSessionRecoveryLifecycle(params: {
  currentLifecycleGeneration: string;
  entry?:
    | (Partial<MainRecoveryStateFields> &
        Pick<
          Partial<SessionEntry>,
          "restartRecoveryDeliveryRunId" | "restartRecoveryTerminalRunIds"
        >)
    | null;
  event: MainRecoveryLifecycleEvent;
  snapshotPatch: Partial<SessionEntry>;
}): { action: "suppress" } | { action: "apply"; patch: Partial<SessionEntry> } {
  const apply = (patch: Partial<SessionEntry>) => ({ action: "apply" as const, patch });
  const { runId, lifecycleGeneration, terminal, matchesFence, suppress, interrupted } =
    inspectMainSessionRecoveryLifecycleEvent(params);
  if (suppress) {
    return { action: "suppress" };
  }
  if (params.entry?.mainRestartRecovery?.tombstone) {
    // Keep the operator boundary while allowing unrelated lifecycle status to settle.
    return apply({
      ...params.snapshotPatch,
      abortedLastRun: params.entry.abortedLastRun,
      restartRecoveryRuns: params.entry.restartRecoveryRuns,
      mainRestartRecovery: params.entry.mainRestartRecovery,
    });
  }
  const patch = { ...params.snapshotPatch };
  if (interrupted || isAgentLifecycleYieldedWaiting(params.event.data ?? {})) {
    return lifecycleGeneration && lifecycleGeneration !== params.currentLifecycleGeneration
      ? { action: "suppress" }
      : apply(patch);
  }
  const runs = params.entry?.restartRecoveryRuns;
  // The current owner retires stale generations of its own run id. An older
  // delayed event consumes only its matching fence and cannot settle its replacement.
  const remaining = matchesFence
    ? runs?.filter(
        (run) =>
          run.runId !== runId ||
          (lifecycleGeneration !== params.currentLifecycleGeneration &&
            run.lifecycleGeneration !== lifecycleGeneration),
      )
    : runs;
  if (terminal) {
    if (!matchesFence || !runId || !lifecycleGeneration) {
      // No terminal snapshot may settle a recovery row it cannot identify.
      return params.entry?.mainRestartRecovery || runs?.length
        ? { action: "suppress" }
        : apply(patch);
    }
    if (
      lifecycleGeneration !== params.currentLifecycleGeneration &&
      remaining?.some(
        (run) =>
          run.runId === runId && run.lifecycleGeneration === params.currentLifecycleGeneration,
      )
    ) {
      // Older generations share the live owner's run id. Consume only their
      // fence; recording that id as terminal would also tombstone its replacement.
      return apply({ restartRecoveryRuns: remaining });
    }
    const foreground = settleForegroundOwner(
      params.entry ?? {},
      runId,
      lifecycleGeneration,
      params.currentLifecycleGeneration,
    );
    if (
      params.entry?.abortedLastRun === true &&
      !foreground.claimId &&
      !foreground.hasCurrentOwner &&
      terminal.reason !== "hard_timeout"
    ) {
      // The restart marker won the session transaction before this normal terminal.
      // Retire the old fence, but only a fresh owner may settle the handoff itself.
      return apply({ restartRecoveryRuns: remaining?.length ? remaining : undefined });
    }
    if (foreground.hasCurrentOwner) {
      // A terminal event may consume its own claim. Another owner still keeps
      // the aggregate live until that owner's terminal event or release.
      return apply({
        restartRecoveryRuns: remaining?.length ? remaining : undefined,
        restartRecoveryTerminalRunIds: mergeRestartRecoveryTerminalRunIds(
          params.entry?.restartRecoveryTerminalRunIds,
          [runId],
        ),
        ...(foreground.claimId ? { mainRestartRecovery: foreground.state } : {}),
      });
    }
    const recoveryDeliveryRunId =
      typeof params.entry?.restartRecoveryDeliveryRunId === "string"
        ? params.entry.restartRecoveryDeliveryRunId.trim()
        : undefined;
    if (!foreground.claimId && (remaining?.length ?? 0) > 0 && recoveryDeliveryRunId !== runId) {
      // A different terminal run may consume only its own fence. Another
      // admitted recovery remains the durable owner of the aggregate.
      patch.abortedLastRun = false;
      patch.restartRecoveryRuns = remaining;
      patch.mainRestartRecovery = params.entry?.mainRestartRecovery;
      return apply(patch);
    }
    // The exact foreground or delivery owner retires the cycle once no live owner remains.
    Object.assign(patch, buildMainSessionRecoveryClearPatch(params.entry));
    patch.abortedLastRun = params.snapshotPatch.abortedLastRun ?? false;
    return apply(patch);
  }
  return apply(patch);
}
