import { randomUUID } from "node:crypto";
import type { GatewayContextResolver } from "../../../gateway/server-methods/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../../infra/agent-events.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import { emitSessionLifecycleEvent } from "../../../sessions/session-lifecycle-events.js";
import { runOpenClawStateWriteTransaction } from "../../../state/openclaw-state-db.js";
import { createQueuedTaskRun, createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import {
  bindTaskRecord,
  upsertTaskRunRowInDatabase,
} from "../../../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../../../tasks/task-registry.types.js";
import { normalizeDeliveryContext } from "../../../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { resolveSubagentRequesterAgentId } from "../../subagent-requester-owner.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import { bindSwarmRunReservation } from "../swarm/swarm-scheduler.js";
import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { SubagentRecoveryManager } from "./subagent-registry-run-recovery.js";
import {
  bindSubagentRunRecord,
  insertSubagentRunRowInDatabase,
  readSubagentRun,
  replaceSubagentRunRowInDatabase,
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
  /** Required when direct dispatch suppresses Gateway tracking. Out-of-process launches keep
      Gateway's existing best-effort CLI policy; other callers create a best-effort row here. */
  taskRowOwnership?: "required" | "gateway_best_effort";
  gatewayContextResolver?: GatewayContextResolver;
};

export type CollectorRunReservation = Pick<SubagentRunRecord, "runId" | "childSessionKey"> & {
  created: boolean;
  expected: SubagentRunRecord;
};

export class SubagentLaunchManager extends SubagentRecoveryManager {
  private findRunByIdentity(runId: string): SubagentRunRecord | undefined {
    return this.options.runs.get(runId);
  }

  private createRunRecord(
    registerParams: RegisterSubagentRunParams,
    overrides?: Partial<
      Pick<
        SubagentRunRecord,
        "createdAt" | "generation" | "collectorLaunchPhase" | "swarmWaitOwnerSessionKeys"
      >
    >,
  ): SubagentRunRecord | undefined {
    const runId = registerParams.runId.trim();
    const childSessionKey = registerParams.childSessionKey.trim();
    const requesterSessionKey = registerParams.requesterSessionKey.trim();
    const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
    const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
    if (!runId || !childSessionKey || !requesterSessionKey) {
      return undefined;
    }
    const now = overrides?.createdAt ?? Date.now();
    const generation =
      overrides?.generation ??
      nextSubagentRunGeneration(
        this.options.getRunsForChildSession(childSessionKey),
        childSessionKey,
      );
    const cfg = this.options.getRuntimeConfig();
    const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
    const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
    return normalizeSubagentRunState({
      runId,
      taskRunId: runId,
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
        overrides?.swarmWaitOwnerSessionKeys ??
        (registerParams.collect && registerParams.swarmRequesterSessionKey
          ? resolveSwarmWaitOwnerSessionKeys(
              this.options.getRunsForChildSession,
              registerParams.swarmRequesterSessionKey,
            )
          : undefined),
      swarmRunId: registerParams.collect ? runId : undefined,
      schedulerSlotId: registerParams.collect ? runId : undefined,
      swarmLaunchIdempotencyKey: registerParams.swarmLaunchIdempotencyKey,
      swarmLaunchReplayKey: registerParams.swarmLaunchReplayKey,
      swarmLaunchRequestFingerprint: registerParams.swarmLaunchRequestFingerprint,
      swarmLaunchPending: registerParams.collect === true,
      collectorLaunchPhase: overrides?.collectorLaunchPhase,
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
  }

  private activateEntry(entry: SubagentRunRecord, waitForCompletion: boolean): void {
    bindSwarmRunReservation(entry.schedulerSlotId ?? entry.runId, entry, () => {
      if (this.options.runs.get(entry.runId) === entry) {
        emitSessionLifecycleEvent({ sessionKey: entry.childSessionKey, reason: "run-capacity" });
      }
    });
    subagentRuns.commitOwnership(entry);
    this.options.ensureListener();
    this.options.startSweeper();
    if (waitForCompletion) {
      const waitTimeoutMs = this.options.resolveSubagentWaitTimeoutMs(
        this.options.getRuntimeConfig(),
        entry.runTimeoutSeconds,
      );
      void this.waitForSubagentCompletion(entry.runId, waitTimeoutMs, entry);
    }
  }

  private commitCollectorTransition(
    expected: SubagentRunRecord,
    next: SubagentRunRecord,
    task?: TaskRecord,
  ): void {
    runOpenClawStateWriteTransaction((database) => {
      if (
        !replaceSubagentRunRowInDatabase({
          database,
          expected: bindSubagentRunRecord(expected),
          next: bindSubagentRunRecord(next),
        })
      ) {
        throw new Error("collector launch state changed before commit");
      }
      if (task) {
        upsertTaskRunRowInDatabase(database, bindTaskRecord(task), task.status === "queued");
      }
    });
    this.restoreRunRecord(expected, next);
    if (task) {
      publishTaskRecordAfterAtomicStore(task);
    }
  }

  private settleCollector(
    entry: SubagentRunRecord,
    error: string,
    taskStatus: "failed" | "lost",
    interrupted = false,
    cleanupPending = false,
  ): boolean {
    if (entry.collectorCompletion) {
      return false;
    }
    const endedAt = entry.execution.endedAt ?? Date.now();
    const next = structuredClone(entry);
    next.endedReason = SUBAGENT_ENDED_REASON_ERROR;
    next.execution = {
      ...next.execution,
      status: "terminal",
      endedAt,
      ...(interrupted ? { interruptedAt: endedAt, interruptionReason: "gateway-restart" } : {}),
      outcome: next.execution.outcome ?? { status: "error", error, endedAt },
    };
    next.swarmLaunchPending = false;
    next.collectorLaunchCleanupPending ||= cleanupPending;
    next.queuedLaunch = undefined;
    next.completion = { required: false, resultText: error, capturedAt: endedAt };
    updateSwarmCollectorCompletion(next, this.options.getRuntimeConfig());
    const taskResolution = this.options.resolveSubagentTask(entry);
    const task =
      taskResolution.lookup === "available" && taskResolution.task
        ? { ...taskResolution.task, status: taskStatus, endedAt, lastEventAt: endedAt, error }
        : undefined;
    this.commitCollectorTransition(entry, next, task);
    return true;
  }

  readonly reserveCollectorRun = (
    registerParams: RegisterSubagentRunParams,
  ): CollectorRunReservation => {
    const candidate = this.createRunRecord(
      { ...registerParams, collect: true, queued: true, queuedLaunch: undefined },
      { collectorLaunchPhase: "reserved" },
    );
    if (!candidate || !candidate.swarmLaunchReplayKey || !candidate.swarmLaunchRequestFingerprint) {
      throw new Error("collector reservation requires replay identity and request fingerprint");
    }
    const inserted = runOpenClawStateWriteTransaction((database) => {
      if (insertSubagentRunRowInDatabase(database, bindSubagentRunRecord(candidate))) {
        return candidate;
      }
      return readSubagentRun(database, candidate.runId);
    });
    if (
      !inserted ||
      inserted.swarmLaunchReplayKey !== candidate.swarmLaunchReplayKey ||
      inserted.swarmLaunchRequestFingerprint !== candidate.swarmLaunchRequestFingerprint ||
      inserted.childSessionKey !== candidate.childSessionKey
    ) {
      throw new Error("collector replay key was reused with a different request");
    }
    const entry = this.options.runs.get(inserted.runId) ?? inserted;
    if (entry === inserted) {
      this.options.runs.set(entry.runId, entry);
      bindGatewayContextResolver(entry, registerParams.gatewayContextResolver);
      this.activateEntry(entry, false);
    }
    return {
      created: inserted === candidate,
      expected: entry,
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
    };
  };

  readonly prepareCollectorRun = (
    reservation: CollectorRunReservation,
    registerParams: RegisterSubagentRunParams,
  ): void => {
    if (
      this.options.runs.get(reservation.runId) !== reservation.expected ||
      reservation.expected.collectorLaunchPhase !== "reserved" ||
      reservation.expected.execution.status !== "queued"
    ) {
      throw new Error("collector reservation is no longer current");
    }
    const entry = this.createRunRecord(
      { ...registerParams, runId: reservation.runId, collect: true, queued: true },
      {
        createdAt: reservation.expected.createdAt,
        generation: reservation.expected.generation,
        collectorLaunchPhase: "prepared",
        swarmWaitOwnerSessionKeys: reservation.expected.swarmWaitOwnerSessionKeys,
      },
    );
    if (!entry) {
      throw new Error("collector prepared run is invalid");
    }
    const now = entry.createdAt;
    const task: TaskRecord = {
      taskId: randomUUID(),
      runtime: "subagent",
      sourceId: entry.runId,
      requesterSessionKey: entry.requesterSessionKey,
      ownerKey: entry.requesterSessionKey,
      scopeKind: "session",
      childSessionKey: entry.childSessionKey,
      agentId: registerParams.agentId,
      requesterAgentId: entry.requesterAgentId,
      runId: entry.runId,
      label: entry.label,
      task: entry.task,
      status: "queued",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: now,
      lastEventAt: now,
      detail: createSubagentTaskBackingDetail(entry.generation!),
    };
    this.commitCollectorTransition(reservation.expected, entry, task);
  };

  readonly markCollectorLaunchDispatching = (runId: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry || entry.execution.status !== "queued") {
      return false;
    }
    if (entry.collectorLaunchPhase !== "prepared") {
      return entry.collectorLaunchPhase === "dispatching";
    }
    const next = structuredClone(entry);
    next.collectorLaunchPhase = "dispatching";
    const changed = runOpenClawStateWriteTransaction((database) =>
      replaceSubagentRunRowInDatabase({
        database,
        expected: bindSubagentRunRecord(entry),
        next: bindSubagentRunRecord(next),
      }),
    );
    if (!changed) {
      return false;
    }
    entry.collectorLaunchPhase = "dispatching";
    return true;
  };

  readonly markCollectorLaunchRunning = (runId: string): boolean =>
    this.startQueuedSubagentRun(runId);

  readonly settleCollectorLaunchAfterRestart = (
    runId: string,
    phase: "reserved" | "dispatching" | "running",
  ): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry || entry.collectorLaunchPhase !== phase || entry.collectorCompletion) {
      return false;
    }
    const error =
      phase === "reserved"
        ? "collector reservation was interrupted before session preparation"
        : phase === "dispatching"
          ? "collector provider dispatch was interrupted; launch was not replayed"
          : "collector provider run was interrupted by gateway restart";
    return this.settleCollector(entry, error, "lost", phase === "running");
  };

  readonly registerSubagentRun = (registerParams: RegisterSubagentRunParams): void => {
    const entry = this.createRunRecord(registerParams);
    if (!entry) {
      return;
    }
    const { runId, childSessionKey, requesterSessionKey } = entry;
    const cfg = this.options.getRuntimeConfig();
    const requesterOrigin = normalizeDeliveryContext(registerParams.requesterOrigin);
    const queued = registerParams.queued === true;
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
    const rollbackRegistration = () => {
      this.options.runs.delete(runId);
      this.restoreKillReconciliationSnapshots(killReconciliationSnapshots);
    };
    const restoreDurableRegistration = () => {
      this.options.runs.set(runId, entry);
      this.restoreKillReconciliationSnapshots(registeredKillReconciliationSnapshots);
    };
    const activateRegistrationLifecycle = () => this.activateEntry(entry, !queued);
    try {
      this.options.persistOrThrow(...registeredRunIds);
    } catch (error) {
      rollbackRegistration();
      throw error;
    }
    if (registerParams.taskRowOwnership !== "gateway_best_effort") {
      try {
        const taskParams = {
          runtime: "subagent",
          sourceId: runId,
          ownerKey: requesterSessionKey,
          scopeKind: "session",
          requesterOrigin: requesterOrigin ? structuredClone(requesterOrigin) : undefined,
          childSessionKey,
          runId,
          label: registerParams.label,
          task: registerParams.task,
          agentId: registerParams.agentId,
          requesterAgentId: resolveSubagentRequesterAgentId(cfg, registerParams),
          deliveryStatus:
            registerParams.expectsCompletionMessage === false ? "not_applicable" : "pending",
          detail: createSubagentTaskBackingDetail(entry.generation!),
        } as const;
        const task = queued
          ? createQueuedTaskRun(taskParams)
          : createRunningTaskRun({
              ...taskParams,
              startedAt: entry.createdAt,
              lastEventAt: entry.createdAt,
            });
        if (!task) {
          if (registerParams.taskRowOwnership === "required") {
            throw new Error(`detached task runtime created no task row for run ${runId}`);
          }
          log.warn("Failed to persist background task for subagent run", { runId });
        }
      } catch (error) {
        if (registerParams.taskRowOwnership !== "required") {
          log.warn("Failed to create background task for subagent run", { runId, error });
        } else {
          // Direct dispatch suppressed Gateway's CLI fallback. Persist the rollback before
          // asking the caller to abort; if that write fails, memory must match durable state.
          rollbackRegistration();
          try {
            this.options.persistOrThrow(...registeredRunIds);
          } catch (rollbackError) {
            restoreDurableRegistration();
            // Durable state still owns this registration. Keep reconciliation active so
            // caller cleanup can terminalize it instead of leaving a phantom run.
            activateRegistrationLifecycle();
            throw rollbackError;
          }
          throw error;
        }
      }
    }
    activateRegistrationLifecycle();
  };

  readonly startQueuedSubagentRun = (
    runId: string,
    _gatewayRunId?: string,
    lifecycleGeneration?: string,
    gatewayContextResolver?: GatewayContextResolver,
  ): boolean => {
    if (
      lifecycleGeneration !== undefined &&
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      return false;
    }
    const entry = this.findRunByIdentity(runId.trim());
    if (
      !entry ||
      entry.killIntent ||
      entry.killReconciliation ||
      entry.collectorLaunchPhase !== "dispatching" ||
      entry.execution.status !== "queued"
    ) {
      return false;
    }
    const acceptedAt = Date.now();
    const next = structuredClone(entry);
    next.execution = {
      ...next.execution,
      status: "running",
      acceptedAt,
      startedAt: acceptedAt,
      lifecycleGeneration: lifecycleGeneration ?? getAgentEventLifecycleGeneration(),
      restartRecovery: undefined,
      suppressSessionEffects: undefined,
    };
    next.sessionStartedAt = acceptedAt;
    next.swarmLaunchPending = false;
    next.collectorLaunchPhase = "running";
    next.queuedLaunch = undefined;
    const taskResolution = this.options.resolveSubagentTask(entry);
    const task =
      taskResolution.lookup === "available" && taskResolution.task
        ? {
            ...taskResolution.task,
            status: "running" as const,
            startedAt: acceptedAt,
            lastEventAt: acceptedAt,
          }
        : undefined;
    if (!task) {
      throw new Error("collector task row was unavailable at provider acceptance");
    }
    this.commitCollectorTransition(entry, next, task);
    bindGatewayContextResolver(entry, gatewayContextResolver);
    void this.waitForSubagentCompletion(
      entry.runId,
      this.options.resolveSubagentWaitTimeoutMs(
        this.options.getRuntimeConfig(),
        entry.runTimeoutSeconds,
      ),
      entry,
    );
    return true;
  };

  readonly settleFailedQueuedSubagentLaunch = (runId: string, error: string): boolean => {
    const entry = this.findRunByIdentity(runId);
    if (!entry?.collect) {
      return false;
    }
    return this.settleCollector(entry, error, "failed", false, true);
  };
}
