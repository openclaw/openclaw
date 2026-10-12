import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  runWithGatewayDetachedWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import {
  isSessionStoreTopologyChange,
  sessionChanges,
} from "../../sessions/session-row-changes.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import { runWithMainSessionRecoveryAdmission } from "./main-session-recovery-admission.js";
import { getMainSessionRecoveryRetryCount } from "./main-session-recovery-state.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";
import {
  restartRecoveryStoreTargetKey,
  type MainSessionRecoverySkipReason,
} from "./main-session-restart-recovery-diagnostics.js";
import {
  loadExpectedRestartRecoveryTarget,
  captureExpectedRestartRecoveryCurrent,
} from "./main-session-restart-recovery-exact-target.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import {
  DEFAULT_RECOVERY_DELAY_MS,
  type ExhaustedRestartRecoveryTarget,
  type ExpectedRestartRecoveryTarget,
  mainSessionRecoveryLog,
  MAX_RECOVERY_RETRIES,
  RETRY_BACKOFF_MULTIPLIER,
  discoverRestartRecoveryStoreTargets,
} from "./main-session-restart-recovery-shared.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

type RecoveryCounts = { started: number; settled: number; failed: number; skipped: number };

function prepareRestartRecovery(gatewayRuntime: GatewayRecoveryRuntime, signal?: AbortSignal) {
  return gatewayRuntime.prepareRestartRecovery(signal)?.then((pausedUntilMs) => {
    if (pausedUntilMs !== undefined) {
      mainSessionRecoveryLog.info(
        `restart-loop breaker tripped; automatic main-session restart recovery paused until ${new Date(pausedUntilMs).toISOString()}`,
      );
    }
    return pausedUntilMs;
  });
}

async function runRecoveryRetries(params: {
  initialDelayMs: number;
  maxRetries: number;
  retryDelayMs?: number;
  shouldContinue: () => boolean;
  signal?: AbortSignal;
  attempt: (finalAttempt: boolean) => Promise<boolean>;
  onError: (error: unknown, finalAttempt: boolean) => void | Promise<void>;
}): Promise<void> {
  let delayMs = params.initialDelayMs;
  for (let attempt = 1; attempt <= params.maxRetries && params.shouldContinue(); attempt += 1) {
    const finalAttempt = attempt === params.maxRetries;
    try {
      if (delayMs > 0) {
        await sleepWithAbort(delayMs, params.signal, { ref: false });
      }
      if (!params.shouldContinue() || (await params.attempt(finalAttempt))) {
        return;
      }
    } catch (error) {
      if (!params.shouldContinue()) {
        return;
      }
      await params.onError(error, finalAttempt);
      if (finalAttempt) {
        return;
      }
    }
    delayMs =
      delayMs > 0
        ? delayMs * RETRY_BACKOFF_MULTIPLIER
        : (params.retryDelayMs ?? DEFAULT_RECOVERY_DELAY_MS);
  }
}

/** The startup owner admits this store sweep before marking or dispatching sessions. */
export async function recoverRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  agentIds?: ReadonlySet<string>;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
  onPreparationPending?: (target: ExhaustedRestartRecoveryTarget) => void;
  stateDir?: string;
  handledSessionKeys?: Set<string>;
  activeSessionIds?: Iterable<string>;
  activeSessionKeys?: Iterable<string>;
  excludedStoreTargets?: ReadonlySet<string>;
  lifecycleGeneration?: string;
  shouldContinue?: () => boolean;
  gatewayRuntime: GatewayRecoveryRuntime;
}): Promise<RecoveryCounts> {
  const result = { started: 0, settled: 0, failed: 0, skipped: 0 };
  if (params.shouldContinue?.() === false) {
    return result;
  }
  const passId = randomUUID();
  const skipReasons = new Map<MainSessionRecoverySkipReason, number>();
  const handledSessionKeys = params.handledSessionKeys ?? new Set<string>();

  for (const target of await discoverRestartRecoveryStoreTargets(params)) {
    if (params.shouldContinue?.() === false) {
      break;
    }
    if (params.excludedStoreTargets?.has(restartRecoveryStoreTargetKey(target))) {
      continue;
    }
    const storeResult = await recoverStore({
      ...params,
      passId,
      storePath: target.storePath,
      storeAgentId: target.agentId,
      handledSessionKeys,
      onSkipped: (reason) => {
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
      },
    });
    result.started += storeResult.started;
    result.settled += storeResult.settled;
    result.failed += storeResult.failed;
    result.skipped += storeResult.skipped;
  }

  if (result.started > 0 || result.settled > 0 || result.failed > 0 || result.skipped > 0) {
    const skipSummary =
      skipReasons.size > 0
        ? ` skipReasons=${[...skipReasons]
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([reason, count]) => `${reason}:${count}`)
            .join(",")}`
        : "";
    mainSessionRecoveryLog.info(
      `main-session restart recovery startup complete: started=${result.started} settled=${result.settled} failed=${result.failed} skipped=${result.skipped}${skipSummary} boot=${params.lifecycleGeneration ?? getAgentEventLifecycleGeneration()} pass=${passId}`,
    );
  }
  return result;
}

/** Retries one exact durable Control UI row from its owning per-agent SQLite store. */
export async function retryRestartAbortedMainSessionRecovery(
  params: MainSessionRecoveryStoreTarget & {
    canonicalSessionKey?: string;
    cfg?: OpenClawConfig;
    expectedRecoveryRunId?: string;
    expectedRecoverySourceRunId?: string;
    expectedSessionId: string;
    stateDir?: string;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<RecoveryCounts> {
  return await recoverExpectedRestartRecovery({
    ...params,
    expectedTarget: {
      agentId: params.agentId,
      canonicalSessionKey: params.canonicalSessionKey,
      sessionId: params.expectedSessionId,
      sessionKey: params.sessionKey,
      claim:
        params.expectedRecoveryRunId && params.expectedRecoverySourceRunId
          ? { runId: params.expectedRecoveryRunId, sourceRunId: params.expectedRecoverySourceRunId }
          : undefined,
    },
  });
}

async function recoverExpectedRestartRecovery(
  params: MainSessionRecoveryStoreTarget & {
    cfg?: OpenClawConfig;
    expectedTarget: ExpectedRestartRecoveryTarget;
    lifecycleGeneration?: string;
    observationOnly?: boolean;
    onPreparationPending?: (target: ExhaustedRestartRecoveryTarget) => void;
    onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
    shouldContinue?: () => boolean;
    signal?: AbortSignal;
    stateDir?: string;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<RecoveryCounts> {
  const expected = {
    ...params.expectedTarget,
    claim: params.expectedTarget.claim && { ...params.expectedTarget.claim },
  };
  const isCurrent = captureExpectedRestartRecoveryCurrent({
    expected,
    storePath: params.storePath,
  });
  const preparation = prepareRestartRecovery(params.gatewayRuntime, params.signal);
  if (preparation && (await preparation) !== undefined) {
    return { started: 0, settled: 0, failed: 0, skipped: 0 };
  }
  if (
    !(await loadExpectedRestartRecoveryTarget({ expected, storePath: params.storePath })) ||
    !isCurrent()
  ) {
    return { started: 0, settled: 0, failed: 0, skipped: 0 };
  }
  return (
    (await runWithMainSessionRecoveryAdmission({
      ...params,
      canonicalSessionKey: expected.canonicalSessionKey,
      sessionId: expected.sessionId,
      isCurrent,
      run: (recoveryAdmission) =>
        recoverStore({
          ...params,
          shouldContinue: recoveryAdmission.shouldContinue,
          handledSessionKeys: new Set<string>(),
          recoveryAdmission,
        }),
    })) ?? { started: 0, settled: 0, failed: 0, skipped: 1 }
  );
}

export function scheduleRestartAbortedMainSessionRecoveryAfterOwnerRelease(
  params: MainSessionRecoveryStoreTarget & {
    delayMs?: number;
    getConfig: () => OpenClawConfig;
    getGatewayRuntime: () => GatewayRecoveryRuntime | undefined;
    maxRetries?: number;
    expectedSessionId: string;
    stateDir?: string;
  },
): void {
  const recover = () =>
    runWithGatewayIndependentRootWorkAdmission(async () => {
      const gatewayRuntime = params.getGatewayRuntime();
      if (!gatewayRuntime) {
        throw new Error("Gateway recovery runtime is unavailable");
      }
      return await retryRestartAbortedMainSessionRecovery({
        ...params,
        cfg: params.getConfig(),
        gatewayRuntime,
      });
    }, "main-session:restart-recovery");
  void runRecoveryRetries({
    initialDelayMs: 0,
    maxRetries: params.maxRetries ?? MAX_RECOVERY_RETRIES,
    retryDelayMs: params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS,
    shouldContinue: () => true,
    attempt: async (finalAttempt) => {
      const result = await recover();
      const stillPending = await loadExpectedRestartRecoveryTarget({
        expected: {
          agentId: params.agentId,
          sessionId: params.expectedSessionId,
          sessionKey: params.sessionKey,
        },
        storePath: params.storePath,
      });
      if (result.failed === 0 && (result.started > 0 || result.settled > 0 || !stillPending)) {
        return true;
      }
      if (
        finalAttempt &&
        getMainSessionRecoveryRetryCount(stillPending?.mainRestartRecovery) ===
          MAX_RECOVERY_RETRIES &&
        !stillPending?.mainRestartRecovery?.reservation
      ) {
        // The last ambiguous dispatch consumed the final durable charge. One
        // exact observation tombstones exhaustion without dispatching again.
        await recover();
      }
      return false;
    },
    onError: (error, finalAttempt) => {
      if (finalAttempt) {
        mainSessionRecoveryLog.warn(`main-session owner-release recovery failed: ${String(error)}`);
      }
    },
  });
}

export function scheduleRestartAbortedMainSessionRecovery(params: {
  delayMs?: number;
  getConfig: () => OpenClawConfig;
  maxRetries?: number;
  shouldContinue?: () => boolean;
  stateDir?: string;
  startupCheckedStorePaths?: Set<string>;
  waitForStart?: () => Promise<void>;
  gatewayRuntime: GatewayRecoveryRuntime;
}): { stop: () => Promise<void> } {
  const handledSessionKeys = new Set<string>();
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const abortController = new AbortController();
  const unregisterRotation = registerAgentEventLifecycleRotationHandler(
    `main-session-restart-recovery:${randomUUID()}`,
    () => abortController.abort(),
  );
  const shouldContinue = () =>
    !abortController.signal.aborted &&
    params.shouldContinue?.() !== false &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
  const startupRecoveryCutoffMs = Date.now();
  const startupCheckedStorePaths = params.startupCheckedStorePaths ?? new Set<string>();
  // Only candidates observed by this startup can wake on later preparation commits.
  const pendingPreparation = new Map<string, Map<string, ExhaustedRestartRecoveryTarget>>();
  const retainPendingPreparation = (target: ExhaustedRestartRecoveryTarget) => {
    const stores = pendingPreparation.get(target.sessionKey) ?? new Map();
    stores.set(target.storePath, target);
    pendingPreparation.set(target.sessionKey, stores);
  };
  const runRecoveryAttempt = async (
    exhaustedTargets: Map<string, ExhaustedRestartRecoveryTarget>,
    agentIds?: ReadonlySet<string>,
  ): Promise<RecoveryCounts | number> => {
    // Startup closes its AsyncWorkScope as soon as the listener is up. Independent
    // admission would keep that already-aborted owner, so every resume throws
    // AbortError and the fail-closed retry budget tombstones a recoverable session.
    // Detached admission owns a fresh scope; abortController still cancels this
    // Gateway's attempts, shutdown, and lifecycle rotation.
    return await runWithGatewayDetachedWorkAdmission(
      async () => {
        const preparation = prepareRestartRecovery(params.gatewayRuntime, abortController.signal);
        const pausedUntilMs = preparation ? await preparation : undefined;
        if (pausedUntilMs !== undefined) {
          return pausedUntilMs;
        }
        if (!shouldContinue()) {
          return { started: 0, settled: 0, failed: 0, skipped: 0 };
        }
        const cfg = params.getConfig();
        const marking = await markStartupOrphanedMainSessionsForRecovery({
          cfg,
          agentIds,
          stateDir: params.stateDir,
          startupCheckedStorePaths,
          updatedBeforeMs: startupRecoveryCutoffMs,
        });
        const result = await recoverRestartAbortedMainSessions({
          cfg,
          agentIds,
          onExhaustedTarget: (target) => {
            exhaustedTargets.set(
              JSON.stringify([
                target.storePath,
                target.agentId,
                target.canonicalSessionKey ?? target.sessionKey,
              ]),
              target,
            );
          },
          stateDir: params.stateDir,
          handledSessionKeys,
          onPreparationPending: retainPendingPreparation,
          excludedStoreTargets: new Set(marking.failedTargets?.map(restartRecoveryStoreTargetKey)),
          lifecycleGeneration,
          shouldContinue,
          gatewayRuntime: params.gatewayRuntime,
        });
        result.failed += marking.failedTargets?.length ?? 0;
        return result;
      },
      "main-session:startup-recovery",
      abortController.signal,
    );
  };
  const reconcileExhaustedTargets = async (targets: Iterable<ExhaustedRestartRecoveryTarget>) => {
    const outcomes = await Promise.allSettled(
      [...targets].map((target) =>
        runWithGatewayIndependentRootWorkAdmission(
          async () =>
            recoverExpectedRestartRecovery({
              ...target,
              cfg: params.getConfig(),
              expectedTarget: target,
              lifecycleGeneration,
              observationOnly: true,
              shouldContinue,
              signal: abortController.signal,
              stateDir: params.stateDir,
              gatewayRuntime: params.gatewayRuntime,
            }),
          "main-session:target-recovery",
          abortController.signal,
        ),
      ),
    );
    for (const outcome of outcomes) {
      if (
        outcome.status === "rejected" &&
        !(
          abortController.signal.aborted &&
          (outcome.reason === abortController.signal.reason ||
            (outcome.reason instanceof Error &&
              outcome.reason.cause === abortController.signal.reason))
        )
      ) {
        mainSessionRecoveryLog.warn(
          `main-session exhaustion reconciliation failed: ${String(outcome.reason)}`,
        );
      }
    }
  };
  let exhaustedTargets = new Map<string, ExhaustedRestartRecoveryTarget>();
  const runRecovery = async (agentIds?: ReadonlySet<string>) => {
    if (params.waitForStart) {
      await Promise.race([params.waitForStart(), waitForAbortSignal(abortController.signal)]);
    }
    await runRecoveryRetries({
      initialDelayMs: params.delayMs ?? DEFAULT_RECOVERY_DELAY_MS,
      maxRetries: Math.max(1, params.maxRetries ?? MAX_RECOVERY_RETRIES),
      shouldContinue,
      signal: abortController.signal,
      attempt: async (finalAttempt) => {
        exhaustedTargets = new Map();
        while (shouldContinue()) {
          const result = await runRecoveryAttempt(exhaustedTargets, agentIds);
          if (typeof result === "number") {
            await sleepWithAbort(Math.max(1, result - Date.now()), abortController.signal, {
              ref: false,
            });
            continue;
          }
          if (result.failed === 0) {
            return true;
          }
          if (finalAttempt && exhaustedTargets.size > 0) {
            await reconcileExhaustedTargets(exhaustedTargets.values());
          }
          return false;
        }
        return true;
      },
      onError: async (err, finalAttempt) => {
        if (finalAttempt) {
          mainSessionRecoveryLog.warn(`main-session restart recovery gave up: ${String(err)}`);
          await reconcileExhaustedTargets(exhaustedTargets.values());
        } else {
          mainSessionRecoveryLog.warn(`main-session restart recovery failed: ${String(err)}`);
        }
      },
    });
  };
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: params.stateDir ?? resolveStateDir(process.env),
  };
  const pendingAgents = new Set(
    listAgentDatabaseAdmissionRefusals({ env })
      .filter((refusal) => refusal.code === "agent-database-inspection-pending")
      .map((refusal) => refusal.agentId),
  );
  const recoverPreparation = async (target: ExhaustedRestartRecoveryTarget) => {
    let exhausted = false;
    const recover = (observationOnly = false) =>
      runWithGatewayIndependentRootWorkAdmission(
        () =>
          recoverExpectedRestartRecovery({
            ...target,
            expectedTarget: target,
            cfg: params.getConfig(),
            stateDir: params.stateDir,
            gatewayRuntime: params.gatewayRuntime,
            lifecycleGeneration,
            shouldContinue,
            observationOnly,
            signal: abortController.signal,
            onPreparationPending: retainPendingPreparation,
            onExhaustedTarget: () => {
              exhausted = true;
            },
          }),
        "main-session:preparation-recovery",
        abortController.signal,
      );
    await runRecoveryRetries({
      initialDelayMs: 0,
      maxRetries: Math.max(1, params.maxRetries ?? MAX_RECOVERY_RETRIES),
      shouldContinue,
      signal: abortController.signal,
      attempt: async (finalAttempt) => {
        exhausted = false;
        let result = await recover();
        if (finalAttempt && exhausted) {
          result = await recover(true);
        }
        if (finalAttempt && result.failed > 0) {
          mainSessionRecoveryLog.warn(
            `main-session preparation recovery gave up for ${target.sessionKey}`,
          );
        }
        return result.failed === 0;
      },
      onError: (error, finalAttempt) => {
        if (finalAttempt) {
          mainSessionRecoveryLog.warn(`main-session preparation recovery failed: ${String(error)}`);
        }
      },
    });
  };
  let run = Promise.resolve().then(async () => {
    await runRecovery();
    // The scan can precede a preparation commit. Recheck its captured candidates once.
    const pending: ExhaustedRestartRecoveryTarget[] = [];
    for (const stores of pendingPreparation.values()) {
      for (const target of stores.values()) {
        pending.push(target);
      }
    }
    pendingPreparation.clear();
    for (const target of pending) {
      await recoverPreparation(target);
    }
  });
  const unsubscribe = sessionChanges.subscribe(
    AsyncLocalStorage.bind((change) => {
      if (!shouldContinue()) {
        return;
      }
      if ("sessionKey" in change) {
        const stores = pendingPreparation.get(change.sessionKey);
        if (!stores) {
          return;
        }
        for (const [storePath, target] of stores) {
          // Publications can use a physical SQLite path instead of the captured logical store.
          // They only wake recovery; the exact reader and admission revalidate the target.
          // Removing before queueing coalesces commits and avoids observing our own dispatch.
          stores.delete(storePath);
          run = run.then(() => recoverPreparation(target));
        }
        if (stores.size === 0) {
          pendingPreparation.delete(change.sessionKey);
        }
        return;
      }
      if (!isSessionStoreTopologyChange(change)) {
        return;
      }
      const admitted = new Set<string>();
      for (const agentId of pendingAgents) {
        const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
        if (refusal?.code === "agent-database-inspection-pending") {
          continue;
        }
        pendingAgents.delete(agentId);
        if (!refusal) {
          admitted.add(agentId);
        }
      }
      if (admitted.size > 0) {
        // Admission can finish after the first scan. Retain this startup's
        // cutoff and serial preparation without borrowing the publisher's scope.
        run = run.then(() => runRecovery(admitted));
      }
    }),
  );
  return {
    stop: async () => {
      unsubscribe();
      pendingPreparation.clear();
      unregisterRotation();
      // Restart recovery belongs to its startup generation; stale timers must
      // never claim a session after that gateway begins draining.
      abortController.abort();
      await run;
    },
  };
}
