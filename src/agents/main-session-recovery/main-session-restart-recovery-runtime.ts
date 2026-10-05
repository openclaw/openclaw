import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { waitForAbortSignal } from "../../infra/abort-signal.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../../process/gateway-work-admission.js";
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
import {
  loadExpectedRestartRecoveryTarget,
  recoverStore,
} from "./main-session-restart-recovery-store.js";

type RecoveryCounts = { started: number; settled: number; failed: number; skipped: number };

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

export async function recoverRestartAbortedMainSessions(params: {
  cfg?: OpenClawConfig;
  agentIds?: ReadonlySet<string>;
  onExhaustedTarget?: (target: ExhaustedRestartRecoveryTarget) => void;
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
  const passId = randomUUID();
  const skipReasons = new Map<MainSessionRecoverySkipReason, number>();
  const handledSessionKeys = params.handledSessionKeys ?? new Set<string>();

  for (const target of await discoverRestartRecoveryStoreTargets({
    ...params,
    statuses: ["running"],
  })) {
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
    shouldContinue?: () => boolean;
    stateDir?: string;
    gatewayRuntime: GatewayRecoveryRuntime;
  },
): Promise<RecoveryCounts> {
  const expected = params.expectedTarget;
  const loadExpected = () =>
    loadExpectedRestartRecoveryTarget({ expected, storePath: params.storePath });
  if (!loadExpected()) {
    return { started: 0, settled: 0, failed: 0, skipped: 0 };
  }
  return (
    (await runWithMainSessionRecoveryAdmission({
      ...params,
      canonicalSessionKey: expected.canonicalSessionKey,
      sessionId: expected.sessionId,
      isCurrent: () => Boolean(loadExpected()),
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
      const stillPending = loadExpectedRestartRecoveryTarget({
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
  const shouldContinue = () =>
    !abortController.signal.aborted &&
    params.shouldContinue?.() !== false &&
    isAgentEventLifecycleGenerationCurrent(lifecycleGeneration);
  const startupRecoveryCutoffMs = Date.now();
  const startupCheckedStorePaths = params.startupCheckedStorePaths ?? new Set<string>();
  const runRecoveryAttempt = async (
    exhaustedTargets: Map<string, ExhaustedRestartRecoveryTarget>,
    agentIds?: ReadonlySet<string>,
  ): Promise<RecoveryCounts> => {
    return await runWithGatewayIndependentRootWorkAdmission(
      async () => {
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
        const result = await runRecoveryAttempt(exhaustedTargets, agentIds);
        if (result.failed === 0) {
          return true;
        }
        if (finalAttempt && exhaustedTargets.size > 0) {
          await reconcileExhaustedTargets(exhaustedTargets.values());
        }
        return false;
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
  let run = Promise.resolve().then(() => runRecovery());
  const unsubscribe = sessionChanges.subscribe(
    AsyncLocalStorage.bind((change) => {
      if (!shouldContinue() || !isSessionStoreTopologyChange(change)) {
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
      if (pendingAgents.size === 0) {
        unsubscribe();
      }
      if (admitted.size > 0) {
        // Admission can finish after the first scan. Retain this startup's
        // cutoff and serial preparation without borrowing the publisher's scope.
        run = run.then(() => runRecovery(admitted));
      }
    }),
  );
  if (pendingAgents.size === 0) {
    unsubscribe();
  }
  return {
    stop: async () => {
      unsubscribe();
      // Restart recovery belongs to its startup generation; stale timers must
      // never claim a session after that gateway begins draining.
      abortController.abort();
      await run;
    },
  };
}
