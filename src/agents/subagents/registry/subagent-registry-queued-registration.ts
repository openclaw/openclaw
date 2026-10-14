import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../../infra/sqlite-worker-contract.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import {
  prepareSwarmCollectorCompletion,
  updateSwarmCollectorCompletion,
} from "../swarm/swarm-collector.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import {
  getCurrentSubagentRunOwner,
  hasPendingSubagentRetirementPublication,
  waitForSubagentRetirementPublication,
} from "./subagent-registry-memory.js";
import {
  SubagentRegistryWriteError,
  mutateSubagentRuns,
  assertSubagentRegistryWriteOutcomeKnown,
  waitForPendingSubagentKillClaim,
} from "./subagent-registry-persistence.js";
import { waitForQueuedSubagentClaim } from "./subagent-registry-queued-registration-wait.js";
import { createQueuedRegistrationSettlement } from "./subagent-registry-queued-settlement.js";
import { createFailedQueuedRun } from "./subagent-registry-run-launch-record.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  getSubagentRunRuntimeKey,
  isSameSubagentRunOwner,
} from "./subagent-run-generation.js";

/** Owns the committed queued intent through descriptor publication and launch settlement. */
export function registerRequiredQueuedSubagent(params: {
  entry: SubagentRunRecord;
  context: OpenClawStateWorkerContext;
  manager: Pick<SubagentManagerOptions, "runs" | "getRunsForChildSession" | "getRuntimeConfig">;
  queuedLaunch: SubagentRunRecord["queuedLaunch"];
  activate: () => void;
  assertCurrent?: () => void;
  retainOwnership?: (scope: SubagentRegistrationScope) => void;
}): Promise<void> {
  const { manager, context } = params;
  const entry = params.entry;
  const currentEntry = () => getCurrentSubagentRunOwner(manager.runs, entry);
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const resolver = getGatewayContextResolver(entry);
  const runId = entry.runId;
  const queuedLaunch = params.queuedLaunch;
  let persistenceUncertain = false;
  let recoveryPending:
    | { kind: "restore" | "retry-terminal"; error: unknown }
    | { kind: "retired" }
    | undefined;
  let descriptorCommitted = false;
  let failureFact: { error: unknown; endedAt: number; message: string } | undefined;
  let settlementPending = false;
  let registrationAcknowledged = false;
  let publishedTerminalExecution: SubagentRunRecord["execution"] | undefined;
  const exactEntry = () => isSameSubagentRunOwner(currentEntry(), entry);
  const ownsSession = () =>
    (!manager.runs.has(runId) || exactEntry()) &&
    !Array.from(manager.getRunsForChildSession(entry.childSessionKey, entry.childAgentId)).some(
      (candidate) =>
        !isSameSubagentRunOwner(candidate, entry) &&
        compareSubagentRunGeneration(candidate, entry) > 0,
    );
  const assertRegistryCurrent = () => {
    context.admission.assertCurrent();
    const current = currentEntry();
    assertSubagentRegistryWriteOutcomeKnown(
      current ? [runId, current.runId] : [runId],
      context.admission,
    );
    if (
      captureOpenClawStateWorkerContext().admission.identity.key !==
        context.admission.identity.key ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      throw new Error("Queued registration lost its original registry owner");
    }
  };
  const registryCurrent = () => {
    try {
      assertRegistryCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const confirmedTakeover = () =>
    Boolean(currentEntry()?.killReconciliation) ||
    (currentEntry()?.execution.status !== "queued" &&
      (currentEntry()?.execution.endedAt !== publishedTerminalExecution?.endedAt ||
        currentEntry()?.execution.outcome?.status !==
          publishedTerminalExecution?.outcome?.status) &&
      !currentEntry()?.killIntent);
  const pendingClaim = () =>
    registryCurrent() &&
    exactEntry() &&
    !confirmedTakeover() &&
    Boolean(
      currentEntry()?.killIntent || waitForPendingSubagentKillClaim(entry, context.admission),
    );
  const waitForClaim = (): Promise<void> | undefined => {
    if (!pendingClaim()) {
      return undefined;
    }
    return (async () => {
      try {
        while (pendingClaim()) {
          const pending = waitForPendingSubagentKillClaim(entry, context.admission);
          if (pending) {
            await pending;
            assertRegistryCurrent();
            if (!exactEntry()) {
              return;
            }
            continue;
          }
          await waitForQueuedSubagentClaim({
            assertCurrent: assertRegistryCurrent,
            admission: context.admission,
            pending: pendingClaim,
          });
        }
      } catch (error) {
        recoveryPending = { kind: "restore", error };
        throw error;
      }
    })();
  };
  const gatewayCurrent = () =>
    getGatewayContextResolver(currentEntry() ?? entry) === resolver &&
    (!resolver || Boolean(resolver()));
  const ownsQueuedIntent = () =>
    !persistenceUncertain &&
    !recoveryPending &&
    !settlementPending &&
    registryCurrent() &&
    exactEntry() &&
    ownsSession() &&
    currentEntry()?.execution.status === "queued" &&
    currentEntry()?.execution.endedAt === undefined &&
    !currentEntry()?.killIntent &&
    !waitForPendingSubagentKillClaim(entry, context.admission) &&
    !currentEntry()?.killReconciliation;
  const assertLaunchCurrent = () => {
    if (!ownsQueuedIntent()) {
      throw new Error("Queued registration lost its original run owner");
    }
  };
  const assertRegistrationCurrent = () => {
    params.assertCurrent?.();
    if (!gatewayCurrent()) {
      throw new Error("Queued registration lost its original Gateway owner");
    }
    assertLaunchCurrent();
  };
  const settlement = createQueuedRegistrationSettlement({
    entry,
    context,
    manager,
    assertRegistryCurrent,
    ownsSession,
    waitForClaim,
    canContinueSettlement: () => canContinueSettlement(),
    canPrepareCancelled: () =>
      registrationAcknowledged && !persistenceUncertain && !recoveryPending,
    setPending: (pending) => {
      settlementPending = pending;
    },
    retire: () => {
      recoveryPending = { kind: "retired" };
    },
    onTerminalPublished: (execution) => {
      publishedTerminalExecution = execution;
    },
  });
  params.retainOwnership?.(
    Object.freeze({
      waitForClaim,
      waitForRetirementPublication: () => waitForSubagentRetirementPublication(entry),
      canLaunch: () => registrationAcknowledged && ownsQueuedIntent(),
      canCleanupSession: () =>
        !persistenceUncertain &&
        !recoveryPending &&
        !settlementPending &&
        !pendingClaim() &&
        !hasPendingSubagentRetirementPublication(entry) &&
        registryCurrent() &&
        ownsSession(),
      canAcceptLaunch: () =>
        registrationAcknowledged && registryCurrent() && exactEntry() && ownsSession(),
      canAbortAcceptedRun: () =>
        registrationAcknowledged && registryCurrent() && exactEntry() && ownsSession(),
      canRetireReservation: () => ownsSwarmRunReservation(runId, getSubagentRunRuntimeKey(entry)),
      settleFailedLaunch: async (error: string) => {
        for (;;) {
          if (
            !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
            captureOpenClawStateWorkerContext().admission.identity.key !==
              context.admission.identity.key ||
            !exactEntry()
          ) {
            return;
          }
          if (recoveryPending?.kind === "restore") {
            throw recoveryPending.error;
          }
          assertRegistryCurrent();
          const claim = waitForClaim();
          if (!claim) {
            break;
          }
          await claim;
        }
        if (settlement.prepareCancelled(error)) {
          await settlement.settleCancelled();
          return;
        }
        if (confirmedTakeover()) {
          recoveryPending = { kind: "retired" };
          settlementPending = false;
          return;
        }
        if (recoveryPending?.kind === "retired") {
          return;
        }
        if (recoveryPending?.kind === "retry-terminal") {
          if (currentEntry()?.killReconciliation || currentEntry()?.execution.status !== "queued") {
            recoveryPending = { kind: "retired" };
            settlementPending = false;
            return;
          }
          if (currentEntry()?.killIntent) {
            throw recoveryPending.error;
          }
          recoveryPending = undefined;
        }
        await failIncompleteRegistration(error);
      },
    }),
  );
  const canContinueSettlement = () => {
    if (
      !registryCurrent() ||
      !exactEntry() ||
      currentEntry()?.execution.status !== "queued" ||
      currentEntry()?.execution.endedAt !== undefined ||
      currentEntry()?.killReconciliation
    ) {
      recoveryPending = { kind: "retired" };
      settlementPending = false;
      return false;
    }
    return true;
  };
  const clearDurableLaunchDescriptor = async (): Promise<boolean> => {
    if (!descriptorCommitted && ownsSession()) {
      return true;
    }
    const published = await settlement.publish("recovery intent", (current, ownedSession) => ({
      ...current,
      queuedLaunch: undefined,
      execution: {
        ...current.execution,
        ...(!ownedSession ? { suppressSessionEffects: true as const } : {}),
      },
    }));
    if (published) {
      descriptorCommitted = false;
    }
    return published;
  };
  const failIncompleteRegistration = async (error: unknown): Promise<void> => {
    if (
      !registryCurrent() ||
      !exactEntry() ||
      currentEntry()?.execution.status !== "queued" ||
      currentEntry()?.killIntent ||
      currentEntry()?.killReconciliation
    ) {
      return;
    }
    settlementPending = true;
    failureFact ??= {
      error,
      endedAt: Date.now(),
      message: error instanceof Error ? error.message : String(error),
    };
    const { endedAt, message, error: cause } = failureFact;
    try {
      if (!(await clearDurableLaunchDescriptor())) {
        return;
      }
      const prepared = await prepareSwarmCollectorCompletion(
        currentEntry() ?? entry,
        manager.getRuntimeConfig(),
        assertRegistryCurrent,
      );
      const published = await settlement.publish("terminal", (current, ownedSession) => {
        const terminal = createFailedQueuedRun(current, message, endedAt, ownedSession);
        updateSwarmCollectorCompletion(terminal, manager.getRuntimeConfig(), prepared);
        return terminal;
      });
      if (!published) {
        return;
      }
    } catch (settlementError) {
      persistenceUncertain =
        hasSqliteWorkerOutcomeUnknown(settlementError) ||
        (settlementError instanceof SubagentRegistryWriteError &&
          settlementError.outcome === "committed");
      const failure = new AggregateError(
        [cause, settlementError],
        "Queued registration failure could not be persisted",
        { cause },
      );
      recoveryPending = {
        kind: persistenceUncertain ? "restore" : "retry-terminal",
        error: failure,
      };
      throw failure;
    }
    settlementPending = false;
    if (registryCurrent() && exactEntry()) {
      params.activate();
    }
  };
  return (async () => {
    for (;;) {
      for (let claim = waitForClaim(); claim; claim = waitForClaim()) {
        await claim;
      }
      if (registryCurrent() && exactEntry() && ownsSession() && confirmedTakeover()) {
        params.activate();
        return;
      }
      try {
        assertRegistrationCurrent();
        const published = await mutateSubagentRuns(
          [runId],
          (rows) => {
            const current = rows.get(runId);
            if (!current || !isSameSubagentRunOwner(current, entry) || !ownsSession()) {
              return { value: "retired" as const };
            }
            if (current.killIntent) {
              return { value: "claim" as const };
            }
            if (current.killReconciliation || current.execution.status !== "queued") {
              return { value: "retired" as const };
            }
            return {
              value: "published" as const,
              postimages: new Map([[runId, { ...current, queuedLaunch }]]),
            };
          },
          {
            runs: manager.runs,
            context,
            assertCurrent: () => {
              params.assertCurrent?.();
              assertRegistryCurrent();
              if (!gatewayCurrent()) {
                throw new Error("Queued registration lost its original Gateway owner");
              }
            },
            onPublished: () => {
              descriptorCommitted = true;
              registrationAcknowledged = true;
            },
          },
        );
        if (published !== "published") {
          continue;
        }
        params.activate();
        return;
      } catch (error) {
        const refused =
          !hasSqliteWorkerOutcomeUnknown(error) &&
          !(error instanceof SubagentRegistryWriteError && error.outcome === "committed");
        if (refused && registryCurrent() && exactEntry() && pendingClaim()) {
          continue;
        }
        if (refused) {
          await failIncompleteRegistration(error);
        } else {
          persistenceUncertain = true;
          recoveryPending = { kind: "restore", error };
        }
        throw error;
      }
    }
  })();
}
