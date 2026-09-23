import { emitAgentEvent } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  captureAgentHarnessTaskAssignment,
  matchesAgentHarnessTaskAssignment,
  type AgentHarnessCompletionCustody,
  type AgentHarnessTaskAssignment,
  type AgentHarnessTaskRecord,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import {
  MAX_PENDING_CHILD_ADMISSION_EVIDENCE,
  consumeNativeChildModelAdmission,
  retainNativeModelSource,
  retainNativeModelExecution,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  DirectSpawnEvidence,
  KnownChild,
  NativeChildAdmissionEvidence,
  NativeSubagentMonitorRuntime,
  ParentState,
  ParentOwner,
  TaskRecoveryCandidate,
} from "./native-subagent-monitor-types.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

export function releaseCompletionCustody(holder: {
  completionCustody?: AgentHarnessCompletionCustody;
}) {
  holder.completionCustody?.release();
  holder.completionCustody = undefined;
}

/** Own retained assignment authority while native evidence waits for its exact parent turn. */
export class CodexNativeSubagentAdmissionCustody {
  // Notifications can precede turn/start's response. Binding selects the parent;
  // custody must remain with that evidence until it is consumed or discarded.
  private readonly pending = new Map<string, NativeChildAdmissionEvidence[]>();

  constructor(
    private readonly dependencies: {
      parentState: (id: string) => ParentState | undefined;
      knownChild: (id: string) => KnownChild | undefined;
      childState: (runId: string) => ChildState | undefined;
      runtime: NativeSubagentMonitorRuntime;
    },
  ) {}

  prepareParentTaskRuntime(state: ParentState, executionPid: number | undefined): void {
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    if (!state.taskRuntime) {
      const runtime = this.dependencies.runtime.createAgentHarnessTaskRuntime({
        runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
        taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
        scope: state.taskRuntimeScope,
        runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
        executionPid,
      });
      state.taskRuntime = {
        ...runtime,
        recordTaskRunProgressByRunId: this.followAssignmentTransition(
          runtime.recordTaskRunProgressByRunId.bind(runtime),
        ),
        finalizeTaskRunByRunId: this.followAssignmentTransition(
          runtime.finalizeTaskRunByRunId.bind(runtime),
        ),
        setDetachedTaskDeliveryStatusByRunId: this.followAssignmentTransition(
          runtime.setDetachedTaskDeliveryStatusByRunId.bind(runtime),
        ),
      };
    }
    // Cached parents retain their original adapter; a new registration must not
    // accept native work after that owner retires or lacks exact settlement.
    state.taskRuntime.assertTaskAssignmentSupported();
    state.mirror ??= new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        historyOwner: state.historyOwner,
        agentId: state.agentId,
        onTaskCreated: (assignment) =>
          this.bindTaskEventSink(this.dependencies.childState(assignment.runId), assignment),
        getCompletionCustody: (runId) => this.dependencies.childState(runId)?.completionCustody,
      },
      state.taskRuntime,
    );
  }

  private followAssignmentTransition<T extends { expectedTask?: AgentHarnessTaskAssignment }>(
    transition: (params: T) => AgentHarnessTaskRecord[],
  ): (params: T) => AgentHarnessTaskRecord[] {
    return (params) => {
      const records = transition(params);
      const previous = params.expectedTask;
      const committed = records.length === 1 ? records[0] : undefined;
      if (
        !previous ||
        !committed ||
        committed.createdAt >= previous.createdAt ||
        !matchesAgentHarnessTaskAssignment(
          { ...committed, createdAt: previous.createdAt },
          previous,
        )
      ) {
        return records;
      }
      const child = this.dependencies.childState(previous.runId);
      const mirror = child && this.dependencies.parentState(child.parentThreadId)?.mirror;
      if (
        !child?.expectedTask ||
        !matchesAgentHarnessTaskAssignment(child.expectedTask, previous)
      ) {
        return records;
      }
      // An exact commit can lower the lifecycle floor. Advance from its own returned
      // record only; a publication-time replacement still fails the next exact check.
      const next = captureAgentHarnessTaskAssignment(committed);
      if (mirror?.advanceTaskAssignment(previous, next)) {
        child.expectedTask = next;
        child.emitTaskEvent = undefined;
        this.bindTaskEventSink(child, next);
      }
      return records;
    };
  }

  get entries(): ReadonlyMap<string, NativeChildAdmissionEvidence[]> {
    return this.pending;
  }

  buffer(turnIdInput: string | undefined, evidence: NativeChildAdmissionEvidence): void {
    const turnId = turnIdInput?.trim();
    const requiresUnboundOwner =
      evidence.kind !== "interaction" || (!evidence.owner && !evidence.modelOwner);
    if (!turnId || (requiresUnboundOwner && !this.hasUnboundParentOwner(evidence.parentThreadId))) {
      return;
    }
    const pending = this.pending.get(turnId) ?? [];
    if (evidence.kind === "interaction" && !evidence.nativeTurnId) {
      // Interrupted continuations leave the receipt queue before their
      // interaction can arrive. Keep pairing against the observed starts.
      const nativeTurn = [
        ...(this.dependencies.knownChild(evidence.childThreadId)?.observedTurns ?? []),
      ].find(
        ([nativeTurnId, observed]) =>
          observed.awaitingInteraction &&
          ![...this.pending.values()]
            .flat()
            .some(
              (candidate) =>
                candidate.kind === "interaction" &&
                candidate.parentThreadId === evidence.parentThreadId &&
                candidate.childThreadId === evidence.childThreadId &&
                candidate.nativeTurnId === nativeTurnId,
            ),
      );
      if (nativeTurn) {
        evidence.nativeTurnId = nativeTurn[0];
      }
    }
    if (
      pending.some(
        (candidate) =>
          candidate.parentThreadId === evidence.parentThreadId &&
          candidate.kind === evidence.kind &&
          candidate.childThreadId === evidence.childThreadId &&
          candidate.agentPath === evidence.agentPath &&
          (candidate.kind === "spawn" ||
            evidence.kind === "spawn" ||
            (candidate.modelSourceTurnId === evidence.modelSourceTurnId &&
              ((candidate.nativeTurnId !== undefined &&
                candidate.nativeTurnId === evidence.nativeTurnId) ||
                (evidence.itemId !== undefined && candidate.itemId === evidence.itemId)))),
      ) ||
      (requiresUnboundOwner &&
        [...this.pending.values()].reduce((count, entries) => count + entries.length, 0) >=
          MAX_PENDING_CHILD_ADMISSION_EVIDENCE)
    ) {
      return;
    }
    try {
      if (evidence.kind === "interaction") {
        evidence.completionCustody ??= (
          evidence.owner ?? evidence.modelOwner
        )?.completionCustody?.retain();
      }
      if (evidence.kind === "interaction" && !evidence.modelSourceConsumed) {
        const owner = evidence.modelOwner ?? evidence.owner;
        if (owner?.unqualifiedModelExecution && !owner.nativeInputConfiguration) {
          evidence.modelSourceRequiresInference = evidence.modelSourceTurnId ? undefined : true;
          evidence.modelSource = retainNativeModelExecution(
            owner,
            undefined,
            evidence.childThreadId,
            evidence.completionCustody,
          );
        } else {
          evidence.modelSource = retainNativeModelSource(owner);
        }
      }
    } catch (error) {
      if (evidence.kind === "interaction") {
        releaseCompletionCustody(evidence);
        consumeNativeChildModelAdmission(evidence);
      }
      throw error;
    }
    pending.push(evidence);
    this.pending.set(turnId, pending);
  }

  hasUnboundParentOwner(parentThreadId: string): boolean {
    const owners = this.dependencies.parentState(parentThreadId)?.owners.values() ?? [];
    return [...owners].some((owner) => owner.turnId === undefined);
  }

  replace(turnId: string, remaining: NativeChildAdmissionEvidence[]): void {
    const previous = this.pending.get(turnId) ?? [];
    for (const evidence of previous) {
      if (evidence.kind === "interaction" && !remaining.includes(evidence)) {
        releaseCompletionCustody(evidence);
      }
    }
    if (remaining.length) {
      this.pending.set(turnId, remaining);
    } else {
      this.pending.delete(turnId);
    }
    for (const evidence of previous) {
      if (evidence.kind === "interaction" && !remaining.includes(evidence)) {
        consumeNativeChildModelAdmission(evidence);
      }
    }
  }

  retainOnly(keep: (evidence: NativeChildAdmissionEvidence) => boolean): void {
    for (const [turnId, pending] of this.pending) {
      this.replace(turnId, pending.filter(keep));
    }
  }

  prune(
    isRetired: (state: ParentState) => boolean,
    hasRecovery: (state: ParentState, threadId: string) => boolean,
  ): void {
    this.retainOnly((evidence) => {
      const known = this.dependencies.knownChild(evidence.childThreadId);
      if (known && known.parent.parentThreadId !== evidence.parentThreadId) {
        return false;
      }
      const state = this.dependencies.parentState(evidence.parentThreadId);
      if (evidence.kind === "interaction" && (evidence.owner || evidence.modelSource)) {
        if (evidence.modelSource && state && !isRetired(state)) {
          return true;
        }
        if (state && evidence.owner && [...state.owners.values()].includes(evidence.owner)) {
          return true;
        }
        return Boolean(
          evidence.admittedOwner && state && hasRecovery(state, evidence.childThreadId),
        );
      }
      return this.hasUnboundParentOwner(evidence.parentThreadId);
    });
  }

  associateUnregisteredChildInteractions(
    state: ParentState,
    threadId: string,
    readRecoveryCandidate: () => TaskRecoveryCandidate | undefined,
  ): void {
    const known = this.dependencies.knownChild(threadId);
    if (known && (known.assignment.terminal || known.assignment.nativeTurnId)) {
      return;
    }
    const candidate = readRecoveryCandidate();
    if (!candidate) {
      return;
    }
    const currentTurnId =
      candidate.nativeTurnId ??
      (!candidate.terminal ? candidate.observedTurns[0]?.turnId : undefined);
    const interactions = [...this.pending.values()]
      .flat()
      .filter(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.parentThreadId === state.parentThreadId &&
          evidence.childThreadId === threadId,
      );
    for (const turn of candidate.observedTurns) {
      if (turn.turnId === currentTurnId) {
        continue;
      }
      const interaction =
        interactions.find(
          (entry) => entry.kind === "interaction" && entry.nativeTurnId === turn.turnId,
        ) ?? interactions.find((entry) => entry.kind === "interaction" && !entry.nativeTurnId);
      if (interaction?.kind !== "interaction") {
        continue;
      }
      interaction.nativeTurnId = turn.turnId;
      if (interaction.owner && [...state.owners.values()].includes(interaction.owner)) {
        interaction.admittedOwner = interaction.owner;
        interaction.completionCustody ??= interaction.owner.completionCustody?.retain();
      }
    }
  }

  registerDirectSpawnChild(
    turnIdInput: string | undefined,
    evidence: DirectSpawnEvidence,
    owner: ParentOwner | undefined,
    registerChild: (
      options: Pick<DirectSpawnEvidence, "agentPath" | "nativeParentThreadId"> & {
        directOwner?: ParentOwner;
      },
    ) => ChildState | undefined,
  ): ChildState | undefined {
    const childState = registerChild({
      ...(evidence.agentPath === undefined ? {} : { agentPath: evidence.agentPath }),
      nativeParentThreadId: evidence.nativeParentThreadId,
      ...(owner ? { directOwner: owner } : {}),
    });
    if (!owner) {
      this.buffer(turnIdInput, { ...evidence, kind: "spawn" });
    } else if (childState) {
      const known = this.dependencies.knownChild(childState.childThreadId);
      if (known) {
        known.configurationQualification = owner.configurationQualification;
      }
      childState.modelExecution ??= retainNativeModelExecution(
        owner,
        childState.nativeTurnId,
        childState.childThreadId,
      );
      owner.onDirectChildAccepted?.();
    }
    return childState;
  }

  bindTaskEventSink(
    child: ChildState | undefined,
    expectedTask?: AgentHarnessTaskAssignment,
  ): void {
    if (child) {
      child.expectedTask ??= expectedTask;
    }
    const parent = child && this.dependencies.parentState(child.parentThreadId);
    const scope = parent?.taskRuntimeScope;
    if (child?.expectedTask) {
      parent?.mirror?.pinTaskAssignment(child.expectedTask);
    }
    if (!child?.completionCustody || !scope || !child.expectedTask || child.emitTaskEvent) {
      return;
    }
    // Bind when the mirror persists or recovery admits the assignment, before a later
    // notification can select a same-id replacement as its original event target.
    child.emitTaskEvent = this.dependencies.runtime.createAgentHarnessTaskEventSink({
      scope,
      completionCustody: child.completionCustody,
      runId: child.runId,
      expectedTask: child.expectedTask,
    });
  }

  emitTaskEvent(
    child: ChildState,
    event: Pick<Parameters<typeof emitAgentEvent>[0], "stream" | "data">,
  ): void {
    const parent = this.dependencies.parentState(child.parentThreadId);
    const scope = parent?.taskRuntimeScope;
    if (child.completionCustody && scope) {
      if (!child.emitTaskEvent) {
        throw new Error("Native task event assignment has not been bound");
      }
      child.emitTaskEvent(event);
      return;
    }
    if (child.expectedTask) {
      // Interrupted turns release execution custody, but their late observations
      // still belong to the original assignment and must never reach its replacement.
      const records = parent?.taskRuntime
        ?.listTaskRecords()
        .filter((task) => task.runId === child.runId);
      const record = records?.[0];
      if (
        records?.length !== 1 ||
        !record ||
        !matchesAgentHarnessTaskAssignment(record, child.expectedTask)
      ) {
        return;
      }
    }
    emitAgentEvent({ ...event, runId: child.runId, agentId: child.agentId });
  }
}
