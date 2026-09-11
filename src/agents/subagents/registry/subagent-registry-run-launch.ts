import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
/** Owns subagent registration and queued collector launch transitions. */
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import {
  acceptDefaultPreparedTaskRunAtomically,
  getDetachedTaskLifecycleRuntime,
  inspectDefaultSubagentTaskBacking,
  isDefaultDetachedTaskLifecycleRuntime,
  finalizeSubagentTaskRunForOwner,
  startTaskRunByRunId,
} from "../../../tasks/detached-task-runtime.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/runtime-internal.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { ensureSingleTaskFlowForDetachedTask } from "../../../tasks/task-executor.js";
import { prepareTaskRecordCreation } from "../../../tasks/task-registry-record-api.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { bindSwarmRunReservation, ownsSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import * as registrationStore from "./subagent-registry-registration-store.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import { publishSubagentRunsAfterAtomicStore } from "./subagent-registry-state.js";
import {
  bindSubagentRunRecord,
  replaceSubagentRunRowInCurrentTransaction,
} from "./subagent-registry.store.sqlite.js";
import type {
  SubagentProgressOrigin,
  SubagentRunRecord,
  SwarmQueuedLaunch,
} from "./subagent-registry.types.js";
import {
  compareSubagentRunGeneration,
  nextSubagentRunGeneration,
} from "./subagent-run-generation.js";
import { resolveNewSubagentTaskOwnershipPolicy } from "./subagent-task-ownership.js";

const log = createSubsystemLogger("agents/subagent-registry");

function resolveSwarmWaitOwnerSessionKeys(
  getRunsForChildSession: (childSessionKey: string) => Iterable<SubagentRunRecord>,
  requesterSessionKey: string,
): string[] {
  const ownerSessionKeys: string[] = [];
  const visited = new Set<string>();
  let currentSessionKey = requesterSessionKey.trim();
  while (currentSessionKey && !visited.has(currentSessionKey)) {
    visited.add(currentSessionKey);
    ownerSessionKeys.push(currentSessionKey);
    let latestOwner: SubagentRunRecord | undefined;
    for (const candidate of getRunsForChildSession(currentSessionKey)) {
      if (!latestOwner || compareSubagentRunGeneration(candidate, latestOwner) > 0) {
        latestOwner = candidate;
      }
    }
    currentSessionKey =
      latestOwner?.controllerSessionKey?.trim() || latestOwner?.requesterSessionKey.trim() || "";
  }
  return ownerSessionKeys;
}

export type RegisterSubagentRunParams = {
  runId: string;
  requesterTurnRunId?: string;
  childSessionKey: string;
  controllerSessionKey?: string;
  requesterSessionKey: string;
  requesterOrigin?: DeliveryContext;
  progressOrigin?: SubagentProgressOrigin;
  requesterDisplayKey: string;
  task: string;
  taskName?: string;
  agentId?: string;
  requesterAgentId?: string;
  cleanup: "delete" | "keep";
  label?: string;
  model?: string;
  agentDir?: string;
  workspaceDir?: string;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  spawnMode?: "run" | "session";
  attachmentsDir?: string;
  attachmentsRootDir?: string;
  retainAttachmentsOnKeep?: boolean;
  collect?: boolean;
  swarmRequesterSessionKey?: string;
  swarmLaunchIdempotencyKey?: string;
  swarmLaunchReplayKey?: string;
  swarmLaunchRequestFingerprint?: string;
  groupId?: string;
  outputSchema?: Record<string, unknown>;
  queuedLaunch?: SwarmQueuedLaunch;
  queued?: boolean;
  /** Declares which runtime owns the task row before registration commits. */
  taskRowOwnership: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};

type SubagentRegistrationResult =
  | Readonly<{ kind: "registered"; runId: string; assertDispatchCurrent: () => void }>
  | Readonly<{ kind: "owned"; runId: string; assertDispatchCurrent: () => void }>;

export class SubagentLaunchManager extends SubagentRecoveryManager {
  readonly registerSubagentRun = (
    registerParams: RegisterSubagentRunParams,
  ): SubagentRegistrationResult | undefined => {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return undefined;
    }
    const now = Date.now();
    const generation = nextSubagentRunGeneration(
      this.options.getRunsForChildSession(childSessionKey),
      childSessionKey,
    );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(cfg, runTimeoutSeconds);
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
    const taskRuntime = getDetachedTaskLifecycleRuntime();
    const usesDefaultTaskRuntime = isDefaultDetachedTaskLifecycleRuntime();
    const taskOwnershipPolicy = resolveNewSubagentTaskOwnershipPolicy({
      taskRowOwnership: registerParams.taskRowOwnership,
      usesDefaultRuntime: usesDefaultTaskRuntime,
    });
    const entry: SubagentRunRecord = normalizeSubagentRunState({
      runId,
      taskRunId: runId,
      taskOwnershipPolicy,
      ...(requesterTurnRunId ? { requesterTurnRunId } : {}),
      childSessionKey,
      controllerSessionKey,
      requesterSessionKey,
      requesterOrigin,
      progressOrigin: registerParams.progressOrigin,
      requesterDisplayKey: registerParams.requesterDisplayKey,
      requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
      task: registerParams.task,
      taskName: registerParams.taskName,
      cleanup: registerParams.cleanup,
      expectsCompletionMessage: registerParams.expectsCompletionMessage,
      spawnMode,
      label: registerParams.label,
      model: registerParams.model,
      agentDir: registerParams.agentDir,
      workspaceDir: registerParams.workspaceDir,
      runTimeoutSeconds,
      collect: registerParams.collect,
      swarmRequesterSessionKey: registerParams.swarmRequesterSessionKey,
      swarmWaitOwnerSessionKeys:
        registerParams.collect && registerParams.swarmRequesterSessionKey
          ? resolveSwarmWaitOwnerSessionKeys(
              this.options.getRunsForChildSession,
              registerParams.swarmRequesterSessionKey,
            )
          : undefined,
      swarmRunId: registerParams.collect ? runId : undefined,
      schedulerSlotId: registerParams.collect ? runId : undefined,
      swarmLaunchIdempotencyKey: registerParams.swarmLaunchIdempotencyKey,
      swarmLaunchReplayKey: registerParams.swarmLaunchReplayKey,
      swarmLaunchRequestFingerprint: registerParams.swarmLaunchRequestFingerprint,
      swarmLaunchPending: registerParams.collect === true,
      groupId: registerParams.groupId,
      outputSchema: registerParams.outputSchema,
      queuedLaunch: registerParams.queuedLaunch,
      generation,
      createdAt: now,
      execution: {
        status: queued ? "queued" : "running",
        startedAt: queued ? undefined : now,
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      completion: {
        required: registerParams.expectsCompletionMessage === true,
      },
      delivery: {
        status: registerParams.expectsCompletionMessage === false ? "not_required" : "pending",
      },
      sessionStartedAt: queued ? undefined : now,
      accumulatedRuntimeMs: 0,
      cleanupHandled: false,
      wakeOnDescendantSettle: undefined,
      requesterSettleWake: undefined,
      attachmentsDir: registerParams.attachmentsDir,
      attachmentsRootDir: registerParams.attachmentsRootDir,
      retainAttachmentsOnKeep: registerParams.retainAttachmentsOnKeep,
    });
    const taskParams = {
      runtime: "subagent",
      sourceId: runId,
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      // Detached task runtimes are plugin-replaceable. Isolate their input so
      // mutation cannot change the already-persisted registry record.
      requesterOrigin: requesterOrigin ? structuredClone(requesterOrigin) : undefined,
      childSessionKey,
      runId,
      label: registerParams.label,
      task: registerParams.task,
      agentId: registerParams.agentId,
      requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
      deliveryStatus:
        registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
      detail: createSubagentTaskBackingDetail(generation),
    } as const;
    registrationStore.assertSubagentRegistrationIdentityAvailable(
      this.options.runs,
      runId,
      (candidateRunId) => this.options.findPersistedSubagentRunIdentityClaim(candidateRunId),
    );
    const preparedRequiredTask =
      taskOwnershipPolicy === "core_required"
        ? prepareTaskRecordCreation({
            ...taskParams,
            status: queued ? "queued" : "running",
            ...(queued ? {} : { startedAt: now, lastEventAt: now }),
          })
        : undefined;
    if (preparedRequiredTask && preparedRequiredTask.kind !== "create") {
      throw new Error(
        `Subagent task run identity ${runId} is already owned. Inspect the existing task before retrying the spawn request.`,
      );
    }
    const previousRunOwner = this.options.runs.get(runId);
    this.options.runs.set(runId, entry);
    bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
    const killReconciliationSnapshots = this.markOlderKillReconciliationsSuperseded(entry);
    const registeredKillReconciliationSnapshots = new Map(
      [...killReconciliationSnapshots.keys()].map((candidate) => [
        candidate,
        structuredClone(candidate.killReconciliation),
      ]),
    );
    const registeredRunIds = [
      runId,
      ...[...killReconciliationSnapshots.keys()].map((candidate) => candidate.runId),
    ];
    const registrationRollback = registrationStore.createSubagentRegistrationRollback({
      runs: this.options.runs,
      runId,
      entry,
      previousRunOwner,
      isCurrent: () => this.currentRunOwnsSession(entry),
      restorePredecessors: () =>
        this.restoreKillReconciliationSnapshots(killReconciliationSnapshots),
      restoreRegisteredPredecessors: () =>
        this.restoreKillReconciliationSnapshots(registeredKillReconciliationSnapshots),
    });
    const activateRegistrationLifecycle = () => {
      bindSwarmRunReservation(entry.schedulerSlotId ?? runId, entry, () => {
        if (this.options.runs.get(entry.runId) === entry) {
          emitSessionLifecycleEvent({ sessionKey: entry.childSessionKey, reason: "run-capacity" });
        }
      });
      subagentRuns.commitOwnership(entry);
      this.options.ensureListener();
      // Session-mode and persistence-recovery runs also need TTL cleanup.
      this.options.startSweeper();
      if (!queued) {
        void this.waitForSubagentCompletion(runId, waitTimeoutMs, entry);
      }
    };
    let registeredTask: TaskRecord | undefined;
    const lifecycleGeneration = entry.execution.lifecycleGeneration;
    const registrationEntryStillExact = (): boolean =>
      this.currentRunOwnsSession(entry) &&
      entry.runId === runId &&
      entry.taskRunId === runId &&
      entry.requesterSessionKey === requesterSessionKey &&
      entry.childSessionKey === childSessionKey &&
      entry.generation === generation &&
      entry.execution.status === (queued ? "queued" : "running") &&
      entry.execution.lifecycleGeneration === lifecycleGeneration;
    const registrationStillCurrent = (task?: { taskId: string; status: string }): boolean => {
      if (!registrationEntryStillExact()) {
        return false;
      }
      if (taskOwnershipPolicy !== "core_required" || !task) {
        return true;
      }
      const backing = inspectDefaultSubagentTaskBacking({
        runId,
        ownerKey: requesterSessionKey,
        sessionKey: childSessionKey,
        generation,
        policy: "failure-finalization",
      });
      return backing.kind === "valid" && backing.task === task;
    };
    if (taskOwnershipPolicy === "core_required") {
      try {
        const prepared = preparedRequiredTask!;
        const registration = registrationStore.commitSubagentTaskRegistration({
          runs: this.options.runs,
          changedRunIds: registeredRunIds,
          entry,
          task: prepared,
          isCurrent: registrationStillCurrent,
        });
        if (!registration.retainedOwnership) {
          if (this.options.runs.get(runId) !== entry) {
            return undefined;
          }
          registeredTask = prepared.record;
        } else {
          ensureSingleTaskFlowForDetachedTask({
            task: registration.task,
            requesterOrigin: taskParams.requesterOrigin,
          });
          const backing = inspectDefaultSubagentTaskBacking({
            runId,
            ownerKey: requesterSessionKey,
            sessionKey: childSessionKey,
            generation,
            policy: queued ? "queued-dispatch" : "failure-finalization",
          });
          if (
            backing.kind === "valid" &&
            this.options.runs.get(runId) === entry &&
            registrationEntryStillExact()
          ) {
            registeredTask = backing.task;
          } else {
            registeredTask = prepared.record;
          }
        }
      } catch (error) {
        registrationRollback.rollback();
        throw error;
      }
    } else {
      try {
        this.options.persistOrThrow(...registeredRunIds);
      } catch (error) {
        registrationRollback.rollback();
        throw error;
      }
      if (taskOwnershipPolicy === "custom") {
        try {
          const task = queued
            ? taskRuntime.createQueuedTaskRun(taskParams)
            : taskRuntime.createRunningTaskRun({
                ...taskParams,
                startedAt: now,
                lastEventAt: now,
              });
          if (!task) {
            throw new Error(`custom task runtime created no task row for run ${runId}`);
          }
        } catch (error) {
          // Custom runtimes own a separate store contract. Preserve their existing
          // rollback path instead of assuming they mirror core task state.
          registrationRollback.rollback();
          try {
            this.options.persistOrThrow(...registeredRunIds);
          } catch (rollbackError) {
            if (registrationRollback.restoreDurable() && registrationStillCurrent()) {
              activateRegistrationLifecycle();
            }
            throw registrationStore.createSubagentRegistrationRollbackError(error, rollbackError);
          }
          throw error;
        }
      }
    }
    // Wait through Gateway RPC; the in-process lifecycle listener is the embedded fallback.
    if (this.options.runs.get(runId) !== entry) {
      return undefined;
    }
    activateRegistrationLifecycle();
    if (this.options.runs.get(runId) !== entry) {
      return undefined;
    }
    const assertDispatchCurrent = () => {
      let taskIsCurrent = true;
      if (taskOwnershipPolicy === "core_required") {
        const backing = inspectDefaultSubagentTaskBacking({
          runId,
          ownerKey: requesterSessionKey,
          sessionKey: childSessionKey,
          generation,
          policy: queued ? "queued-dispatch" : "failure-finalization",
        });
        taskIsCurrent = backing.kind === "valid" && backing.task === registeredTask;
      }
      if (
        !registrationEntryStillExact() ||
        lifecycleGeneration === undefined ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        (entry.collect === true &&
          !ownsSwarmRunReservation(entry.schedulerSlotId ?? runId, entry)) ||
        !taskIsCurrent
      ) {
        throw new Error("Subagent dispatch ownership changed. Retry the spawn request.");
      }
    };
    if (taskOwnershipPolicy === "gateway_best_effort") {
      return Object.freeze({ kind: "registered", runId, assertDispatchCurrent });
    }
    return Object.freeze({ kind: "owned", runId, assertDispatchCurrent });
  };

  readonly startQueuedSubagentRun = (
    runId: string,
    gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    const key = runId.trim();
    const entry = registrationStore.findSubagentRunByIdentity(this.options.runs, key);
    if (entry?.taskOwnershipPolicy === "legacy_unresolved") {
      return false;
    }
    const acceptedLifecycleGeneration = lifecycleGeneration ?? getAgentEventLifecycleGeneration();
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const lifecycleStarted =
      entry?.execution.status === "running" &&
      typeof entry.execution.startedAt === "number" &&
      entry.swarmLaunchPending === true;
    const provisionalTerminalBeforeAcceptance =
      entry?.swarmLaunchPending === true &&
      typeof entry.execution.endedAt === "number" &&
      entry.collectorCompletion === undefined;
    if (provisionalTerminalBeforeAcceptance) {
      // Cancellation won before Gateway acceptance. The caller must abort the
      // newly accepted run before freezing completion or releasing the FIFO slot.
      return false;
    }
    // Completion clears swarmLaunchPending, but queuedLaunch remains until the
    // delayed acceptance response remaps the durable terminal row.
    const terminalBeforeAcceptance =
      entry?.collectorCompletion !== undefined && entry.queuedLaunch !== undefined;
    if (
      !entry ||
      entry.killIntent ||
      entry.killReconciliation ||
      (!terminalBeforeAcceptance && entry.execution.status !== "queued" && !lifecycleStarted)
    ) {
      return false;
    }
    const nextRunId = gatewayRunId?.trim() || entry.runId;
    const conflicting = this.options.runs.get(nextRunId);
    if (conflicting && conflicting !== entry) {
      throw new Error(`collector gateway run id already exists: ${nextRunId}`);
    }
    const acceptedAt = Date.now();
    const previousRunId = entry.runId;
    const previous = structuredClone(entry);
    const next = structuredClone(entry);
    next.swarmRunId ??= previousRunId;
    next.taskRunId ??= previousRunId;
    next.schedulerSlotId ??= next.swarmRunId;
    next.runId = nextRunId;
    if (!terminalBeforeAcceptance) {
      // Acceptance is not a lifecycle start; preserve a raced start or leave its clock unset.
      const lifecycleStartedAt =
        next.execution.status === "running" ? next.execution.startedAt : undefined;
      if (typeof lifecycleStartedAt === "number") {
        next.sessionStartedAt ??= lifecycleStartedAt;
        next.execution = {
          ...next.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
          startedAt: lifecycleStartedAt,
        };
      } else {
        delete next.sessionStartedAt;
        next.execution = {
          ...next.execution,
          status: "running",
          acceptedAt,
          lifecycleGeneration: acceptedLifecycleGeneration,
          restartRecovery: undefined,
          suppressSessionEffects: undefined,
        };
        delete next.execution.startedAt;
      }
    }
    next.swarmLaunchPending = false;
    next.queuedLaunch = undefined;
    const taskRunId = entry.taskRunId ?? entry.runId;
    const acceptedTask = acceptDefaultPreparedTaskRunAtomically({
      runId: taskRunId,
      runtime: "subagent",
      sessionKey: entry.childSessionKey,
      ownerKey: entry.requesterSessionKey,
      generation: entry.generation,
      acceptedAt,
      preserveTaskState: terminalBeforeAcceptance,
      commitPeer: () => {
        if (
          !replaceSubagentRunRowInCurrentTransaction({
            expected: bindSubagentRunRecord(entry),
            next: bindSubagentRunRecord(next),
          })
        ) {
          throw new Error("collector run state changed before gateway acceptance");
        }
      },
    });
    let acceptedOwnershipCurrent = true;
    if (acceptedTask) {
      if (previousRunId !== nextRunId) {
        this.options.runs.delete(previousRunId);
      }
      this.restoreRunRecord(entry, next);
      this.options.runs.set(nextRunId, entry);
      bindGatewayContextResolver(entry, gatewayContextResolver);
      const isAcceptedOwnerCurrent = () => {
        if (!this.currentRunOwnsSession(entry)) {
          return false;
        }
        const backing = inspectDefaultSubagentTaskBacking({
          runId: taskRunId,
          ownerKey: entry.requesterSessionKey,
          sessionKey: entry.childSessionKey,
          generation: entry.generation,
          policy: "failure-finalization",
        });
        return (
          backing.kind === "valid" &&
          backing.task.taskId === acceptedTask.taskId &&
          backing.task.status === acceptedTask.status
        );
      };
      // Observers reenter cancellation and wait paths. Publish both authoritative
      // caches before releasing either callback, without a second store write.
      const deferredObserverEvents: Array<() => void> = [];
      publishSubagentRunsAfterAtomicStore(
        this.options.runs,
        [...new Set([previousRunId, nextRunId])],
        deferredObserverEvents,
        { isCurrent: isAcceptedOwnerCurrent },
      );
      publishTaskRecordAfterAtomicStore(acceptedTask, {
        deferredObserverEvents,
      });
      for (const emitObserverEvent of deferredObserverEvents) {
        if (!isAcceptedOwnerCurrent()) {
          acceptedOwnershipCurrent = false;
          break;
        }
        emitObserverEvent();
      }
      acceptedOwnershipCurrent = acceptedOwnershipCurrent && isAcceptedOwnerCurrent();
    } else {
      const restoreQueuedRun = () => {
        if (previousRunId !== nextRunId) {
          this.options.runs.delete(nextRunId);
        }
        this.restoreRunRecord(entry, previous);
        this.options.runs.set(previousRunId, entry);
      };
      if (previousRunId !== nextRunId) {
        this.options.runs.delete(previousRunId);
      }
      this.restoreRunRecord(entry, next);
      this.options.runs.set(nextRunId, entry);
      let persistedAccepted = false;
      try {
        this.options.persistOrThrow(previousRunId, nextRunId);
        persistedAccepted = true;
        if (!terminalBeforeAcceptance) {
          startTaskRunByRunId({
            runId: taskRunId,
            runtime: "subagent",
            sessionKey: entry.childSessionKey,
            startedAt: acceptedAt,
            lastEventAt: acceptedAt,
          });
        }
      } catch (error) {
        restoreQueuedRun();
        if (persistedAccepted) {
          try {
            this.options.persistOrThrow(previousRunId, nextRunId);
          } catch (rollbackError) {
            log.warn("failed to persist collector start rollback", {
              runId: previousRunId,
              error: rollbackError,
            });
          }
        }
        throw error;
      }
      bindGatewayContextResolver(entry, gatewayContextResolver);
    }
    if (terminalBeforeAcceptance) {
      return true;
    }
    if (!acceptedOwnershipCurrent || !this.currentRunOwnsSession(entry)) {
      return true;
    }
    const cfg = this.options.getRuntimeConfig();
    void this.waitForSubagentCompletion(
      nextRunId,
      this.options.resolveSubagentWaitTimeoutMs(cfg, entry.runTimeoutSeconds),
      entry,
    );
    return true;
  };

  readonly failQueuedSubagentRun = (runId: string, error: string): boolean => {
    const key = runId.trim();
    const entry = registrationStore.findSubagentRunByIdentity(this.options.runs, key);
    if (entry?.taskOwnershipPolicy === "legacy_unresolved") {
      return false;
    }
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    const snapshot = structuredClone(entry);
    const endedAt = Date.now();
    entry.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt,
      outcome: { status: "error", error, endedAt },
    };
    entry.queuedLaunch = undefined;
    entry.collectorLaunchCleanupPending = true;
    entry.taskTerminalProjection = "preserve_existing";
    entry.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    try {
      finalizeSubagentTaskRunForOwner({
        runId: entry.taskRunId ?? entry.runId,
        ownerKey: entry.requesterSessionKey,
        sessionKey: entry.childSessionKey,
        generation: entry.generation,
        status: "failed",
        endedAt,
        lastEventAt: endedAt,
        error,
        suppressDelivery: true,
        preserveTerminalState: true,
      });
    } catch (taskError) {
      // Collector failure is already durable. Detached-task cleanup cannot
      // turn it back into queued work or the scheduler could launch it twice.
      log.warn("failed to finalize task after collector launch failure", {
        runId: entry.runId,
        error: taskError,
      });
    }
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = registrationStore.findSubagentRunByIdentity(this.options.runs, runId);
    if (entry?.taskOwnershipPolicy === "legacy_unresolved") {
      return false;
    }
    if (!entry?.collect) {
      return false;
    }
    if (typeof entry.execution.endedAt !== "number") {
      return this.failQueuedSubagentRun(runId, error);
    }
    if (entry.collectorCompletion) {
      return true;
    }
    const snapshot = structuredClone(entry);
    entry.swarmLaunchPending = false;
    entry.collectorLaunchCleanupPending = true;
    entry.taskTerminalProjection = "preserve_existing";
    entry.queuedLaunch = undefined;
    entry.execution = {
      ...entry.execution,
      status: "terminal",
      endedAt: entry.execution.endedAt,
    };
    entry.completion = {
      required: false,
      resultText:
        entry.execution.outcome?.status === "error"
          ? (entry.execution.outcome.error ?? error)
          : error,
      capturedAt: entry.execution.endedAt,
    };
    updateSwarmCollectorCompletion(entry, this.options.getRuntimeConfig());
    try {
      this.options.persistOrThrow(entry.runId);
    } catch (persistError) {
      this.restoreRunRecord(entry, snapshot);
      throw persistError;
    }
    return true;
  };
}
