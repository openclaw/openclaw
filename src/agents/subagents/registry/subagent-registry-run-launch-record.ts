import { normalizeSubagentRunState } from "./subagent-delivery-state.js";
import type { RegisterSubagentRunParams, SubagentRunRecord } from "./subagent-registry.types.js";

export function createSubagentRegistrationRecord(
  registerParams: RegisterSubagentRunParams,
  prepared: {
    now: number;
    generation: number;
    lifecycleGeneration: string;
    requesterAgentId?: string;
    requesterOrigin?: SubagentRunRecord["requesterOrigin"];
    swarmWaitOwnerSessionKeys?: string[];
  },
): SubagentRunRecord {
  const { now, generation, requesterOrigin } = prepared;
  const runId = registerParams.runId.trim();
  const childSessionKey = registerParams.childSessionKey.trim();
  const requesterSessionKey = registerParams.requesterSessionKey.trim();
  const requesterTurnRunId = registerParams.requesterTurnRunId?.trim();
  const controllerSessionKey = registerParams.controllerSessionKey?.trim() || requesterSessionKey;
  const spawnMode = registerParams.spawnMode === "session" ? "session" : "run";
  const runTimeoutSeconds = registerParams.runTimeoutSeconds ?? 0;
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
    requesterAgentId: prepared.requesterAgentId,
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
    swarmWaitOwnerSessionKeys: prepared.swarmWaitOwnerSessionKeys,
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
      lifecycleGeneration: prepared.lifecycleGeneration,
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
