import { isDeepStrictEqual } from "node:util";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { getGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import type {
  CreatedDetachedTaskRun,
  DetachedRunningTaskCreateParams,
} from "../../../tasks/detached-task-runtime-contract.js";
import {
  prepareRunningTaskRun,
  type PreparedDetachedTaskRun,
} from "../../../tasks/detached-task-runtime.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { getTaskRunOwner } from "../../../tasks/task-run-owner.js";
import { ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { subagentRuns, waitForSubagentRetirementPublication } from "./subagent-registry-memory.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import type { SubagentManagerOptions } from "./subagent-registry-run-wait.js";
import type { RegisterSubagentRunOptions, SubagentRunRecord } from "./subagent-registry.types.js";
import { compareSubagentRunGeneration } from "./subagent-run-generation.js";

const log = createSubsystemLogger("agents/subagent-registry");

/** The launch manager keeps ordinary registrations private until their worker acknowledges them. */
export async function registerRunningSubagent(params: {
  entry: SubagentRunRecord;
  previous: SubagentRunRecord | undefined;
  context: OpenClawStateWorkerContext;
  manager: Pick<SubagentManagerOptions, "runs" | "getRunsForChildSession" | "persistAsyncOrThrow">;
  ownership: ReturnType<typeof subagentRuns.captureRegistrationOwnership>;
  taskParams: DetachedRunningTaskCreateParams;
  taskRowOwnership: "required" | "gateway_best_effort" | undefined;
  publishAuthority: () => void;
  activate: (publishOwnership: boolean) => void;
  options: RegisterSubagentRunOptions;
}): Promise<void> {
  const { entry, previous, context, manager, ownership, options } = params;
  const runId = entry.runId;
  const lifecycleGeneration = entry.execution.lifecycleGeneration;
  const resolver = getGatewayContextResolver(entry);
  const registered = structuredClone(entry);
  const previousState = previous && structuredClone(previous);
  const previousCurrent = () =>
    manager.runs.get(runId) === previous && isDeepStrictEqual(previous, previousState);
  const originals = new Map<SubagentRunRecord, SubagentRunRecord>();
  const snapshot = new Map([[runId, registered]]);
  for (const candidate of manager.getRunsForChildSession(entry.childSessionKey)) {
    if (
      candidate.runId === runId ||
      compareSubagentRunGeneration(candidate, entry) >= 0 ||
      !candidate.killReconciliation
    ) {
      continue;
    }
    const original = structuredClone(candidate);
    originals.set(candidate, original);
    snapshot.set(candidate.runId, {
      ...original,
      killReconciliation: {
        ...original.killReconciliation!,
        supersededAt: Math.min(
          original.killReconciliation?.supersededAt ?? entry.createdAt,
          entry.createdAt,
        ),
      },
    });
  }
  let acknowledged = false;
  let uncertain = false;
  let activated = false;
  let receipt: CreatedDetachedTaskRun | undefined;
  let legacy: Extract<PreparedDetachedTaskRun, { kind: "legacy" }> | undefined;
  const exactEntry = () => manager.runs.get(runId) === entry;
  const ownsSession = () =>
    !ownership.superseded &&
    (!manager.runs.has(runId) || exactEntry()) &&
    !Array.from(manager.getRunsForChildSession(entry.childSessionKey)).some(
      (candidate) => candidate !== entry && compareSubagentRunGeneration(candidate, entry) > 0,
    );
  const assertRegistryCurrent = () => {
    context.admission.assertCurrent();
    if (
      captureOpenClawStateWorkerContext().admission.identity.key !==
        context.admission.identity.key ||
      !lifecycleGeneration ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      throw new Error("Subagent registration lost its original registry owner");
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
  const assertLaunchCurrent = () => {
    assertRegistryCurrent();
    ownership.assertCurrent();
    options.assertCurrent?.();
    if (
      !exactEntry() ||
      !ownsSession() ||
      entry.killIntent ||
      entry.killReconciliation ||
      getGatewayContextResolver(entry) !== resolver ||
      (resolver && !resolver())
    ) {
      throw new Error("Subagent registration lost its original run owner");
    }
  };
  const activate = () => {
    if (!activated && registryCurrent() && exactEntry() && !uncertain) {
      activated = true;
      params.activate(!ownership.superseded);
    }
  };
  const settleCreatedTask = async (error: unknown) => {
    const task = receipt?.task ?? legacy?.task;
    if (!task) {
      return;
    }
    const terminal = {
      status: "failed" as const,
      endedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      suppressDelivery: true,
    };
    const canSettle = () => {
      assertRegistryCurrent();
      return (
        !ownership.sameRunSuperseded &&
        !getTaskRunOwner(task) &&
        (!manager.runs.has(runId) || exactEntry())
      );
    };
    if (receipt) {
      await receipt.settleUnstarted(terminal, canSettle);
    } else if (canSettle()) {
      legacy?.finalizeRun({
        ...terminal,
        runtime: "subagent",
        runId,
        taskId: task.taskId,
        sessionKey: entry.childSessionKey,
        suppressDelivery: true,
      });
    }
  };
  options.retainOwnership?.({
    waitForClaim: () => undefined,
    waitForRetirementPublication: () => waitForSubagentRetirementPublication(entry),
    canLaunch: () => activated && registryCurrent() && exactEntry() && ownsSession(),
    canAcceptLaunch: () => acknowledged && registryCurrent() && exactEntry() && ownsSession(),
    canAbortAcceptedRun: () => registryCurrent() && ownsSession(),
    canCleanupSession: () => !uncertain && registryCurrent() && ownsSession() && !exactEntry(),
    canRetireReservation: () => ownsSwarmRunReservation(entry.schedulerSlotId ?? runId, entry),
    settleFailedLaunch: async (error) => {
      if (uncertain) {
        throw new Error("Subagent registration requires recovery before launch settlement");
      }
      if (!activated) {
        await settleCreatedTask(error);
      }
    },
  });
  const rollback = async () => {
    if (
      ownership.superseded ||
      !registryCurrent() ||
      !exactEntry() ||
      !isDeepStrictEqual(entry, registered)
    ) {
      return;
    }
    const restored = new Map<string, SubagentRunRecord>();
    const retained = new Map<SubagentRunRecord, SubagentRunRecord>();
    for (const [candidate, original] of originals) {
      if (
        manager.runs.get(candidate.runId) === candidate &&
        isDeepStrictEqual(candidate, snapshot.get(candidate.runId))
      ) {
        restored.set(candidate.runId, original);
        retained.set(candidate, structuredClone(candidate));
      }
    }
    const assertRollbackCurrent = () => {
      assertRegistryCurrent();
      ownership.assertCurrent();
      if (!exactEntry() || !isDeepStrictEqual(entry, registered)) {
        throw new Error("Subagent registration rollback lost its original run owner");
      }
      for (const [candidate, current] of retained) {
        if (
          manager.runs.get(candidate.runId) !== candidate ||
          !isDeepStrictEqual(candidate, current)
        ) {
          throw new Error("Subagent registration rollback lost its predecessor");
        }
      }
    };
    try {
      await manager.persistAsyncOrThrow(
        context,
        {
          snapshot: restored,
          assertCurrent: assertRollbackCurrent,
          onCommitted: (runIds) => {
            if (runIds.includes(runId) && exactEntry() && isDeepStrictEqual(entry, registered)) {
              manager.runs.delete(runId);
              subagentRuns.releaseCompletionAuthority(entry);
            }
            if (ownership.superseded) {
              return;
            }
            for (const [candidate, current] of retained) {
              if (
                runIds.includes(candidate.runId) &&
                manager.runs.get(candidate.runId) === candidate &&
                isDeepStrictEqual(candidate, current)
              ) {
                candidate.killReconciliation = restored.get(candidate.runId)?.killReconciliation;
              }
            }
          },
        },
        runId,
        ...Array.from(retained.keys(), (candidate) => candidate.runId),
      );
    } catch (error) {
      uncertain = !(
        error instanceof SubagentRegistryWriteError && error.outcome === "not-committed"
      );
      if (!uncertain) {
        activate();
      }
      throw error;
    }
  };
  try {
    await manager.persistAsyncOrThrow(
      context,
      {
        snapshot,
        assertCurrent: () => {
          assertRegistryCurrent();
          ownership.assertCurrent();
          options.assertCurrent?.();
          if (!previousCurrent()) {
            throw new Error("Subagent registration owner changed before commit");
          }
          for (const [candidate, original] of originals) {
            if (
              manager.runs.get(candidate.runId) !== candidate ||
              !isDeepStrictEqual(candidate, original)
            ) {
              throw new Error("Subagent registration predecessor changed before commit");
            }
          }
        },
        onCommitted: (runIds) => {
          for (const [candidate, original] of originals) {
            if (
              runIds.includes(candidate.runId) &&
              manager.runs.get(candidate.runId) === candidate &&
              isDeepStrictEqual(candidate, original)
            ) {
              candidate.killReconciliation = snapshot.get(candidate.runId)?.killReconciliation;
            }
          }
          if (!runIds.includes(runId) || !previousCurrent() || ownership.sameRunSuperseded) {
            return;
          }
          assertRegistryCurrent();
          manager.runs.set(runId, entry);
          acknowledged = true;
          params.publishAuthority();
          if (!ownership.superseded) {
            ownership.accept(entry);
          }
        },
      },
      ...snapshot.keys(),
    );
  } catch (error) {
    uncertain = !(error instanceof SubagentRegistryWriteError && error.outcome === "not-committed");
    if (
      error instanceof SubagentRegistryWriteError &&
      error.outcome === "committed" &&
      acknowledged
    ) {
      uncertain = false;
      activate();
    }
    throw error;
  }
  if (!acknowledged) {
    throw new Error("Subagent registration was superseded before acknowledgement");
  }
  try {
    assertLaunchCurrent();
    if (params.taskRowOwnership !== "gateway_best_effort") {
      try {
        const assertTaskCreationCurrent = () => {
          assertLaunchCurrent();
          if (entry.execution.status !== "running" || entry.execution.endedAt !== undefined) {
            throw new Error("Subagent registration already has a terminal owner");
          }
        };
        const prepared = prepareRunningTaskRun(params.taskParams, assertTaskCreationCurrent);
        let task: TaskRecord | null | undefined;
        if (prepared.kind === "legacy") {
          legacy = prepared;
          task = prepared.task;
        } else {
          try {
            receipt = (await prepared.create()) ?? undefined;
            task = receipt?.task;
          } catch (error) {
            // As with queued creation, a missing receipt cannot prove that no task committed.
            uncertain = true;
            throw error;
          }
        }
        if (!task) {
          if (params.taskRowOwnership === "required") {
            throw new Error(`detached task runtime created no task row for run ${runId}`);
          }
          log.warn("Failed to persist background task for subagent run", { runId });
        }
      } catch (error) {
        if (params.taskRowOwnership === "required") {
          throw error;
        }
        log.warn("Failed to create background task for subagent run", { runId, error });
      }
    }
    assertLaunchCurrent();
    // The acknowledged registry remains the owner when its optional task row fails.
    uncertain = false;
    activate();
  } catch (error) {
    try {
      if (!uncertain) {
        await settleCreatedTask(error);
        await rollback();
        activate();
      }
    } catch (settlementError) {
      uncertain = true;
      throw new AggregateError(
        [error, settlementError],
        "Subagent registration settlement failed",
        { cause: settlementError },
      );
    }
    throw error;
  } finally {
    receipt?.release();
  }
}
