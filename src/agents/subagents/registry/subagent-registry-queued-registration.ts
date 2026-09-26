import { isDeepStrictEqual } from "node:util";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import {
  hasPendingSubagentRetirementPublication,
  waitForSubagentRetirementPublication,
} from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { waitForQueuedSubagentClaim } from "./subagent-registry-queued-registration-wait.js";
import { createQueuedRegistrationSettlement } from "./subagent-registry-queued-settlement.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import { onSubagentRegistryPersisted } from "./subagent-registry-state.js";
import type { SubagentRegistrationScope, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

/** Required queued registration retains its exact owner across both persistence acknowledgements. */
export function registerRequiredQueuedSubagent(params: {
  entry: SubagentRunRecord;
  context: OpenClawStateWorkerContext;
  manager: Pick<
    SubagentManagerOptions,
    "runs" | "getRunsForChildSession" | "getRuntimeConfig" | "persistAsyncOrThrow"
  >;
  originals: Map<SubagentRunRecord, SubagentRunRecord["killReconciliation"]>;
  bindReservation: () => void;
  activate: () => void;
  assertCurrent?: () => void;
  retainOwnership?: (scope: SubagentRegistrationScope) => void;
}): Promise<void> {
  const { entry, manager, originals, context } = params;
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const resolver = getGatewayContextResolver(entry);
  const runId = entry.runId;
  const generation = entry.generation;
  const createdAt = entry.createdAt;
  const queuedLaunch = entry.queuedLaunch;
  const registered = new Map(
    [...originals].map(([previous]) => [previous, structuredClone(previous.killReconciliation)]),
  );
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
  const exactEntry = () =>
    entry.runId === runId &&
    manager.runs.get(runId) === entry &&
    entry.generation === generation &&
    entry.createdAt === createdAt;
  const ownsSession = () =>
    entry.runId === runId &&
    (!manager.runs.has(runId) || exactEntry()) &&
    !Array.from(manager.getRunsForChildSession(entry.childSessionKey)).some(
      (candidate) => candidate !== entry && compareSubagentRunGeneration(candidate, entry) > 0,
    );
  const assertRegistryCurrent = () => {
    context.admission.assertCurrent();
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
    Boolean(entry.killReconciliation) ||
    (entry.execution.status !== "queued" &&
      entry.execution !== publishedTerminalExecution &&
      !entry.killIntent);
  const pendingClaim = () => exactEntry() && Boolean(entry.killIntent) && !confirmedTakeover();
  const waitForClaim = (): Promise<void> | undefined => {
    if (!pendingClaim()) {
      return undefined;
    }
    return (async () => {
      try {
        while (pendingClaim()) {
          await waitForQueuedSubagentClaim({
            assertCurrent: assertRegistryCurrent,
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
    getGatewayContextResolver(entry) === resolver && (!resolver || Boolean(resolver()));
  const ownsQueuedIntent = () =>
    !persistenceUncertain &&
    !recoveryPending &&
    !settlementPending &&
    registryCurrent() &&
    exactEntry() &&
    ownsSession() &&
    entry.execution.status === "queued" &&
    entry.execution.endedAt === undefined &&
    !entry.killIntent &&
    !entry.killReconciliation;
  const assertLaunchCurrent = () => {
    if (!ownsQueuedIntent()) {
      throw new Error("Queued registration lost its original run owner");
    }
  };
  const settlement = createQueuedRegistrationSettlement({
    entry,
    context,
    manager,
    assertRegistryCurrent,
    registryCurrent,
    exactEntry,
    ownsSession,
    waitForClaim,
    pendingClaim,
    confirmedTakeover,
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
      canRetireReservation: () => ownsSwarmRunReservation(runId, entry),
      settleFailedLaunch: async (error: string) => {
        for (;;) {
          if (!registryCurrent() || !exactEntry()) {
            return;
          }
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
        if (recoveryPending?.kind === "restore") {
          throw recoveryPending.error;
        }
        if (recoveryPending?.kind === "retry-terminal") {
          if (entry.killReconciliation || entry.execution.status !== "queued") {
            recoveryPending = { kind: "retired" };
            settlementPending = false;
            return;
          }
          if (entry.killIntent) {
            throw recoveryPending.error;
          }
          recoveryPending = undefined;
        }
        await failIncompleteRegistration(error);
      },
    }),
  );
  // Restore already treats a queued row without a descriptor as an incomplete intent.
  entry.queuedLaunch = undefined;
  params.bindReservation();
  const intent = structuredClone(entry);
  const rollbackMemory = () => {
    if (
      !registryCurrent() ||
      !exactEntry() ||
      !ownsSession() ||
      !isDeepStrictEqual(entry, intent)
    ) {
      return undefined;
    }
    manager.runs.delete(runId);
    const restored = new Map(
      [...originals].filter(
        ([previous]) =>
          manager.runs.get(previous.runId) === previous &&
          isDeepStrictEqual(previous.killReconciliation, registered.get(previous)),
      ),
    );
    for (const [previous, snapshot] of restored) {
      previous.killReconciliation = snapshot;
    }
    return restored;
  };
  const canContinueSettlement = () => {
    if (
      !registryCurrent() ||
      !exactEntry() ||
      entry.execution.status !== "queued" ||
      entry.execution.endedAt !== undefined ||
      entry.killReconciliation
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
    const published = await settlement.publish("recovery intent", (ownedSession) => ({
      ...entry,
      queuedLaunch: undefined,
      execution: {
        ...entry.execution,
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
      entry.execution.status !== "queued" ||
      entry.killIntent ||
      entry.killReconciliation
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
    const terminalEndedAt = endedAt;
    const terminalError = message;
    let failedSettlement: { error: unknown } | undefined;
    try {
      if (!(await clearDurableLaunchDescriptor())) {
        return;
      }
      const published = await settlement.publish("terminal", (ownedSession) => {
        const terminal = structuredClone(entry);
        terminal.endedReason = SUBAGENT_ENDED_REASON_ERROR;
        terminal.execution = {
          ...terminal.execution,
          status: "terminal",
          endedAt: terminalEndedAt,
          outcome: { status: "error", error: terminalError, endedAt: terminalEndedAt },
          ...(!ownedSession ? { suppressSessionEffects: true } : {}),
        };
        terminal.queuedLaunch = undefined;
        terminal.collectorLaunchCleanupPending = true;
        terminal.completion = {
          required: false,
          resultText: terminalError ?? null,
          capturedAt: terminalEndedAt,
        };
        updateSwarmCollectorCompletion(terminal, manager.getRuntimeConfig());
        return terminal;
      });
      if (!published) {
        return;
      }
    } catch (settlementError) {
      persistenceUncertain = !(
        settlementError instanceof SubagentRegistryWriteError &&
        settlementError.outcome === "not-committed"
      );
      failedSettlement = { error: settlementError };
    }
    if (failedSettlement) {
      const failure = new AggregateError(
        [cause, failedSettlement.error],
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
    let intentAcknowledged = false;
    for (;;) {
      for (let claim = waitForClaim(); claim; claim = waitForClaim()) {
        await claim;
      }
      if (registryCurrent() && exactEntry() && ownsSession() && confirmedTakeover()) {
        params.activate();
        return;
      }
      if (intentAcknowledged) {
        break;
      }
      let observedClaim = false;
      const stopObservingClaim = onSubagentRegistryPersisted(() => {
        if (exactEntry() && entry.killIntent) {
          observedClaim = true;
        }
      });
      try {
        await manager.persistAsyncOrThrow(
          context,
          {
            assertCurrent: () => {
              params.assertCurrent?.();
              if (!gatewayCurrent()) {
                throw new Error("Queued registration lost its original Gateway owner");
              }
              assertLaunchCurrent();
            },
          },
          runId,
          ...Array.from(originals.keys(), (previous) => previous.runId),
        );
        intentAcknowledged = true;
      } catch (error) {
        const refused =
          error instanceof SubagentRegistryWriteError && error.outcome === "not-committed";
        if (
          refused &&
          registryCurrent() &&
          exactEntry() &&
          (observedClaim || pendingClaim() || (ownsSession() && confirmedTakeover()))
        ) {
          continue;
        }
        if (refused) {
          if (!rollbackMemory()) {
            await failIncompleteRegistration(error);
          }
        } else {
          persistenceUncertain = true;
          recoveryPending = { kind: "restore", error };
        }
        throw error;
      } finally {
        stopObservingClaim();
      }
    }
    for (;;) {
      for (let claim = waitForClaim(); claim; claim = waitForClaim()) {
        await claim;
      }
      if (registryCurrent() && exactEntry() && ownsSession() && confirmedTakeover()) {
        params.activate();
        return;
      }
      try {
        params.assertCurrent?.();
        if (!gatewayCurrent()) {
          throw new Error("Queued registration lost its original Gateway owner");
        }
        assertLaunchCurrent();
      } catch (error) {
        await failIncompleteRegistration(error);
        throw error;
      }
      if (registrationAcknowledged) {
        params.activate();
        return;
      }
      let observedClaim = false;
      const stopObservingClaim = onSubagentRegistryPersisted(() => {
        if (exactEntry() && entry.killIntent) {
          observedClaim = true;
        }
      });
      try {
        entry.queuedLaunch = queuedLaunch;
        // Snapshot synchronously, then hide the descriptor until authoritative publication.
        let publication: Promise<void>;
        try {
          publication = manager.persistAsyncOrThrow(
            context,
            {
              assertCurrent: () => {
                params.assertCurrent?.();
                if (!gatewayCurrent()) {
                  throw new Error("Queued registration lost its original Gateway owner");
                }
                assertLaunchCurrent();
              },
              onCommitted: () => {
                descriptorCommitted = true;
                if (ownsQueuedIntent()) {
                  entry.queuedLaunch = queuedLaunch;
                  registrationAcknowledged = true;
                }
              },
            },
            runId,
          );
        } finally {
          entry.queuedLaunch = undefined;
        }
        await publication;
        descriptorCommitted = true;
      } catch (error) {
        const refused =
          error instanceof SubagentRegistryWriteError && error.outcome === "not-committed";
        if (
          refused &&
          registryCurrent() &&
          exactEntry() &&
          (observedClaim || pendingClaim() || (ownsSession() && confirmedTakeover()))
        ) {
          continue;
        }
        persistenceUncertain = !refused;
        recoveryPending = { kind: "restore", error };
        throw error;
      } finally {
        stopObservingClaim();
      }
      // A committed claim/release can supersede this publication with a hidden
      // descriptor. Continue from the known task; only the descriptor needs a new write.
    }
  })();
}
