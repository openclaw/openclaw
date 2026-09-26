import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  normalizeOptionalString,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  CodexNativeSubagentAdmissionCustody,
  releaseCompletionCustody,
} from "./native-subagent-admission-custody.js";
import { CodexNativeSubagentAssignmentInventory } from "./native-subagent-assignment-inventory.js";
import {
  codexNativeSubagentRunId,
  normalizeIdentifier,
  readCodexNativeSubagentRunId,
  readNativeSubagentThreadIds,
  readThreadParentThreadId,
  readThreadSpawnSource,
  type NativeSubagentAssignment,
} from "./native-subagent-assignment.js";
import {
  CodexNativeSubagentCloseOwner,
  isCodexNativeSubagentCloseNotification,
} from "./native-subagent-close-owner.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
import {
  buildCodexNativeSubagentAgentPathKey as buildParentAgentPathKey,
  observeCodexNativeSubagentDeliveryReceipts,
  registerCodexNativeSubagentReceiptAlias,
  resolveCodexNativeSubagentReceiptOwner,
  type CodexNativeSubagentDeliveryReceipts,
} from "./native-subagent-delivery-receipts.js";
import {
  CodexNativeSubagentHistoryRecovery,
  isNoFinalCompletion,
  readNativeTurnEnd,
  readTurnCompletion,
  systemErrorFallbackCompletion,
} from "./native-subagent-history-recovery.js";
import {
  prepareNativeModelToolInput,
  drainNativeChildModelAdmissions,
} from "./native-subagent-model-input.js";
import {
  currentNativeModelExecution,
  resolveNativeModelThreadId,
  resolveNativeModelParentOwner,
} from "./native-subagent-model-lookup.js";
import {
  associateNativeChildInteraction,
  captureNativeModelSource,
  closeNativeModelChild,
  notifyNativeModelSourceChange,
  notifyNativeModelSourceWaiters,
  releaseNativeModelExecution,
  releaseNativeDirectChild,
  releaseNativeParentModelSources,
  releasePendingNativeModelInputs,
} from "./native-subagent-model-source.js";
import {
  createCodexNativeSubagentMonitorRuntime,
  defaultNativeSubagentMonitorRuntime,
} from "./native-subagent-monitor-runtime.js";
import type {
  ChildState,
  DirectSpawnEvidence,
  KnownChild,
  MonitorOptions,
  NativeModelToolInputRequest,
  NativeModelSourceCapture,
  NativeModelSourceRequest,
  NativeSubagentMonitorClient,
  NativeSubagentMonitorRuntime,
  NativeTurnObservation,
  ParentOwner,
  ParentRegistrationHandle,
  ParentState,
  ThreadRecovery,
} from "./native-subagent-monitor-types.js";
import {
  NATIVE_SUBAGENT_NOTIFICATION_METHODS,
  RECOVERY_REVISION_NOTIFICATION_METHODS,
  codexNativeSubagentNotifications as nativeSubagentNotifications,
  type CodexNativeSubagentCompletion,
} from "./native-subagent-notification.js";
import {
  observeNativeParentTurn,
  registerNativeSubagentParent,
  type NativeParentRegistration,
} from "./native-subagent-parent-owner.js";
import { matchesNativeAssignmentLifecycle } from "./native-subagent-pending-assignments.js";
import {
  CodexNativeSubagentRecoveryCoordinator,
  logRecoveryFailure,
} from "./native-subagent-recovery-coordinator.js";
import { CodexNativeSubagentSubmissionOwner } from "./native-subagent-submission-owner.js";
import { CodexNativeSubagentTurnObservation } from "./native-subagent-turn-observation.js";
import type { CodexServerNotification, JsonObject } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

class Monitor {
  private readonly assignments: CodexNativeSubagentAssignmentInventory;
  private readonly submissions: CodexNativeSubagentSubmissionOwner;
  private readonly historyRecovery: CodexNativeSubagentHistoryRecovery;
  private readonly completionDelivery: CodexNativeSubagentCompletionDelivery;
  private readonly turnObservation: CodexNativeSubagentTurnObservation;
  private readonly recovery: CodexNativeSubagentRecoveryCoordinator;
  private readonly parentStates = new Map<string, ParentState>();
  private readonly admissionCustody: CodexNativeSubagentAdmissionCustody;
  private readonly retiredParentStates = new WeakSet<ParentState>();
  private readonly childStates = new Map<string, ChildState>();
  // Native threads survive completed assignments; task runs and delivery remain per assignment.
  private readonly knownChildren = new Map<string, KnownChild>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly interruptModelExecution?: MonitorOptions["interruptModelExecution"];
  private readonly now: () => number;
  private readonly removeNotificationHandler: () => void;
  private readonly removeCloseHandler: () => void;
  private readonly retainClient?: () => (() => void) | undefined;
  private readonly retainParentThread?: (threadId: string) => (() => void) | undefined;
  private readonly claimChildThread?: (threadId: string) => Promise<unknown>;
  private readonly retainChildThread?: (threadId: string) => Promise<unknown>;
  private readonly releaseChildThread?: (threadId: string) => Promise<unknown>;
  private readonly childCloses: CodexNativeSubagentCloseOwner;
  private readonly parentThreadRetentions = new Map<string, () => void>();
  private releaseClientRetention?: () => void;
  private disposed = false;

  constructor(
    private readonly client: NativeSubagentMonitorClient,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultNativeSubagentMonitorRuntime,
    options: MonitorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.interruptModelExecution = options.interruptModelExecution;
    this.admissionCustody = new CodexNativeSubagentAdmissionCustody({
      parentState: (id) => this.parentStates.get(id),
      knownChild: (id) => this.knownChildren.get(id),
      childState: (runId) => this.childStates.get(runId),
      runtime,
    });
    this.retainClient = options.retainClient;
    this.retainParentThread = options.retainParentThread;
    this.claimChildThread = options.claimChildThread;
    this.retainChildThread = options.retainChildThread;
    this.releaseChildThread = options.releaseChildThread;
    this.childCloses = new CodexNativeSubagentCloseOwner(client, {
      isParentCurrent: (state) => this.isCurrentParent(state),
      isParentRetired: (state) => this.retiredParentStates.has(state),
      knownChild: (id) => this.knownChildren.get(id),
      currentChild: (id) => this.currentChild(id),
      captureForget: options.captureChildThreadForget,
      releaseDirectChild: (child) => releaseNativeDirectChild(child),
      clearRecoveryTimers: (child) => this.recovery.clearRecoveryTimers(child),
      markTerminalRevision: (id) => this.recovery.markTerminalRevision(id),
      unregisterChild: (child) => this.unregisterChild(child, { retainSubscription: false }),
      releaseClientRetentionIfIdle: () => this.releaseClientRetentionIfIdle(),
      pruneParent: (state) => this.pruneParentIfUnused(state),
    });
    this.historyRecovery = new CodexNativeSubagentHistoryRecovery(client, {
      getPendingTurnIds: (id) =>
        this.knownChildren.get(id)?.pendingTurns.map((turn) => turn.turnId) ?? [],
      getCurrentAssignmentState: (id) => {
        const known = this.knownChildren.get(id);
        return {
          runId: known?.assignment.runId,
          nativeTurnState: this.currentChild(id)?.nativeTurnState,
        };
      },
    });
    this.completionDelivery = new CodexNativeSubagentCompletionDelivery({
      deliver: (params) => runtime.deliverAgentHarnessCompletion(params),
      now: this.now,
      retryDelaysMs: options.completionDeliveryRetryDelaysMs,
      maxRetries: options.completionDeliveryMaxRetries,
      isCurrentChild: (child) => this.childStates.get(child.runId) === child,
      isCurrentParent: (state) => this.parentStates.get(state.parentThreadId) === state,
      isRetiredParent: (state) => this.retiredParentStates.has(state),
      getParent: (id) => this.parentStates.get(id),
      unregisterChild: (child) => this.unregisterChild(child),
      releaseClientRetentionIfIdle: () => this.releaseClientRetentionIfIdle(),
    });
    this.turnObservation = new CodexNativeSubagentTurnObservation({
      emitTaskEvent: (child, event) => this.admissionCustody.emitEvent(child, event),
      currentChild: (id) => this.currentChild(id),
      dependencyRunId: (parentThreadId, childThreadId) => {
        const receiver = this.knownChildren.get(childThreadId);
        return receiver?.parent.parentThreadId === parentThreadId
          ? receiver.assignment.runId
          : undefined;
      },
      onTurnEnded: (child) => {
        if (child.nativeTurnState) {
          releaseNativeDirectChild(child);
          releaseNativeModelExecution(child);
        }
        const state = this.parentStates.get(child.parentThreadId);
        return state ? this.recordObservedChildTurn(state, child) : undefined;
      },
    });
    this.recovery = new CodexNativeSubagentRecoveryCoordinator({
      isDisposed: () => this.disposed,
      isRegisteredChild: (child) => this.childStates.get(child.runId) === child,
      currentChild: (id) => this.currentChild(id),
      parentState: (id) => this.parentStates.get(id),
      isRetiredParent: (state) => this.retiredParentStates.has(state),
      reconcileChildState: (child) => this.reconcileChildState(child),
      processCompletion: (state, child, completion, eventAt) =>
        this.processCompletion(state, child, completion, eventAt),
      now: this.now,
      recoveryPollDelaysMs: options.recoveryPollDelaysMs,
    });
    this.removeNotificationHandler = client.addNotificationHandler(async (notification) => {
      if (!NATIVE_SUBAGENT_NOTIFICATION_METHODS.has(notification.method)) {
        return;
      }
      try {
        await this.handleNotification(notification);
      } finally {
        notifyNativeModelSourceChange(notification.method, this.parentStates.values());
      }
    });
    this.submissions = new CodexNativeSubagentSubmissionOwner({
      isCurrent: (state) => {
        if (!this.isCurrentParent(state)) {
          return false;
        }
        try {
          state.submissionStore?.assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      assertPersistenceCurrent: (state) => {
        if (
          this.retiredParentStates.has(state) ||
          (!this.disposed && this.parentStates.get(state.parentThreadId) !== state)
        ) {
          throw new Error("Native submission parent generation is no longer current.");
        }
        state.submissionStore?.assertCurrent();
      },
      parentOwner: (state, turnId) => this.resolveParentOwner(state, turnId),
      client: this.client,
      recovery: this.recovery,
      knownChildren: this.knownChildren,
      currentChild: (id) => this.currentChild(id),
      currentModelExecution: (id) =>
        currentNativeModelExecution(id, this.parentStates, this.knownChildren, this.childStates),
      restoreKnownChild: (state, assignment) => this.restoreKnownChild(state, assignment),
      prepareReceiver: (state, threadId) => this.prepareReceiverChild(state, threadId),
      registerChild: (state, assignment, childOptions) =>
        this.registerChildThread(state, assignment, childOptions),
      admitFollowup: (known, id) => this.admitFollowupChild(known, id),
      resumeChild: (child) => this.resumeChild(child),
      completeChild: (notification, child) => this.handleChildTurnCompletion(notification, child),
      retain: (state, threadId) => {
        const releases = [
          this.retainClient?.(),
          this.retainParentThread?.(state.parentThreadId),
          this.retainParentThread?.(threadId),
        ];
        let retained = true;
        return () => {
          if (!retained) {
            return;
          }
          retained = false;
          for (const release of releases) {
            release?.();
          }
        };
      },
      hasObservationBacking: options.hasObservationBacking,
      acceptContinuation: (state, owner, threadId, call, modelOwner) => {
        if (!call.submissionId) {
          throw new Error("Codex model input admission requires its accepted submission ID");
        }
        this.observeParentInteraction(state, owner, threadId, undefined, {
          parentTurnId: call.parentTurnId,
          itemId: call.callId,
          modelSourceTurnId: call.submissionId,
          modelOwner,
        });
      },
      recordPendingAssignment: (state, receipt, nativeParentThreadId) =>
        this.assignments.recordSubmission(state, receipt, nativeParentThreadId),
      onSettled: (state) => this.pruneParentIfUnused(state),
      recoveryPollDelaysMs: options.recoveryPollDelaysMs,
    });
    this.assignments = new CodexNativeSubagentAssignmentInventory({
      assertCurrent: (state) => {
        if (
          this.retiredParentStates.has(state) ||
          (!this.disposed && this.parentStates.get(state.parentThreadId) !== state)
        ) {
          throw new Error("Native assignment parent is no longer current.");
        }
        state.assignmentStore?.assertCurrent();
      },
      isCurrent: (state) =>
        !this.disposed &&
        !this.retiredParentStates.has(state) &&
        this.parentStates.get(state.parentThreadId) === state,
      readHistory: async (assignment) => {
        const revision = this.recovery.retainThreadStatusRevision(assignment.childThreadId);
        try {
          const history = await this.historyRecovery.read(
            { ...assignment, nativeTurnId: assignment.nativeTurnId },
            {
              resumeInterrupted: assignment.recordedCompletion === undefined,
              predecessorNativeTurnId: assignment.submission?.predecessorNativeTurnId,
              recordedCompletion: assignment.recordedCompletion,
              initialAssignment: !readCodexNativeSubagentRunId(assignment.runId)?.turnId,
            },
          );
          return revision.isCurrent() ? history : undefined;
        } finally {
          revision.release();
        }
      },
      restore: async (state, assignment, recovery, custody) => {
        const existing = this.childStates.get(assignment.runId);
        if (existing) {
          const original = this.parentStates.get(existing.parentThreadId);
          if (
            original &&
            original.requesterSessionKey === state.requesterSessionKey &&
            original.historyOwner &&
            state.historyOwner &&
            matchesNativeAssignmentLifecycle(original.historyOwner, state.historyOwner)
          ) {
            // Rotation updates only the persistence owner. Live execution/model
            // admission and its close order stay with the original parent.
            original.assignmentStore = state.assignmentStore;
          }
          return;
        }
        const child = this.registerChildThread(
          state,
          {
            runId: assignment.runId,
            childThreadId: assignment.childThreadId,
            nativeTurnId: assignment.nativeTurnId,
          },
          {
            admitAssignment: true,
            completionCustody: custody,
            historyOwner: assignment.owner,
            nativeParentThreadId: assignment.nativeParentThreadId,
            ...(recovery.agentPath ? { agentPath: recovery.agentPath } : {}),
          },
        );
        if (!child) {
          return;
        }
        child.recoverInitialAssignment = !readCodexNativeSubagentRunId(assignment.runId)?.turnId
          ? true
          : undefined;
        this.recordRecoveredChildTurn(state, child, recovery);
        if (recovery.resumable) {
          this.settleResumableChild(child);
        } else if (recovery.threadState === "active") {
          this.observeActiveChild(child);
        } else {
          await this.processRecoveredCompletion(state, child, recovery);
        }
      },
      onSettled: (state) => this.pruneParentIfUnused(state),
    });
    this.removeCloseHandler = client.addCloseHandler(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.submissions.dispose();
    this.removeNotificationHandler();
    this.removeCloseHandler();
    for (const childState of this.childStates.values()) {
      try {
        this.turnObservation.invalidate(childState);
      } catch (error) {
        // Revoked event custody cannot stop disposal from releasing other native owners.
        embeddedAgentLog.debug("Native activity invalidation lost its owner", {
          error: formatErrorMessage(error),
        });
      }
      releaseNativeDirectChild(childState);
      releaseNativeModelExecution(childState);
      // Terminal delivery no longer needs app-server. Keep its bounded retry
      // alive if idle-pool eviction closes this client between attempts.
      if (childState.terminal && childState.pendingCompletion) {
        this.recovery.clearRecoveryTimers(childState);
        continue;
      }
      this.unregisterChild(childState);
    }
    this.releaseRetainedClient();
    for (const release of this.parentThreadRetentions.values()) {
      release();
    }
    this.parentThreadRetentions.clear();
    for (const state of this.parentStates.values()) {
      for (const owner of state.owners.values()) {
        releaseCompletionCustody(owner);
      }
      releaseNativeParentModelSources(state, this.knownChildren.values());
      state.owners.clear();
      state.turnIds.clear();
      notifyNativeModelSourceWaiters(state);
      this.childCloses.clear(state);
      this.completionDelivery.deliverDetached(state, this.childStates.values());
    }
    this.admissionCustody.retainOnly(() => false);
    for (const [parentThreadId] of this.parentStates) {
      if (
        ![...this.childStates.values()].some(
          (childState) => childState.parentThreadId === parentThreadId,
        )
      ) {
        this.parentStates.delete(parentThreadId);
      }
    }
    for (const known of this.knownChildren.values()) {
      known.pendingTurns.forEach(releaseCompletionCustody);
    }
    this.knownChildren.clear();
    this.childThreadIdsByAgentPath.clear();
  }

  registerParent(params: NativeParentRegistration): Promise<ParentRegistrationHandle> {
    return registerNativeSubagentParent(params, {
      states: this.parentStates,
      children: this.childStates,
      isClosed: () => this.disposed,
      isRetired: (state) => this.retiredParentStates.has(state),
      runtime: this.runtime,
      submissions: this.submissions,
      assignments: this.assignments,
      closes: this.childCloses,
      deliverPending: (state, child) => this.completionDelivery.deliverPending(state, child),
      deliverDetached: (state) =>
        this.completionDelivery.deliverDetached(state, this.childStates.values()),
      drainAdmissions: (state, owner, turnId) =>
        this.drainPendingChildAdmissionEvidence(state, owner, turnId, true),
      clearAdmissions: () => this.clearUnconsumablePendingChildAdmissionEvidence(),
      prune: (state) => this.pruneParentIfUnused(state),
      interruptModelExecution: this.interruptModelExecution,
    });
  }

  async captureModelSource(
    request: NativeModelSourceRequest,
  ): Promise<NativeModelSourceCapture | undefined> {
    const capture = await captureNativeModelSource(request, {
      parents: this.parentStates,
      children: this.childStates,
      knownChildren: this.knownChildren,
      admissions: this.admissionCustody.entries,
      assertInputCurrent: (threadId, owner) =>
        this.submissions.assertModelInputCurrent(threadId, owner),
      hasPendingInput: (input) => this.submissions.hasPendingModelInput(input),
      onExecutionAdmitted: (known, threadId) => {
        this.admitFollowupChild(known, threadId);
      },
      registerChildExecution: (state, modelRequest, agentPath, completionCustody) => {
        this.registerChildThread(
          state,
          {
            runId: codexNativeSubagentRunId(modelRequest.threadId, modelRequest.turnId),
            childThreadId: modelRequest.threadId,
            nativeTurnId: modelRequest.turnId,
          },
          {
            agentPath,
            completionCustody,
            nativeParentThreadId: modelRequest.parentThreadId,
            observedTurns: [{ turnId: modelRequest.turnId, state: "active" }],
          },
        );
      },
      isCurrent: (state) => this.isCurrentParent(state),
    });
    if (!capture) {
      return undefined;
    }
    try {
      await this.persistModelAssignment(request, capture);
      request.signal?.throwIfAborted();
      capture.assertCurrent();
      return capture;
    } catch (error) {
      capture.release();
      throw error;
    }
  }

  private async persistModelAssignment(
    request: NativeModelSourceRequest,
    capture: NativeModelSourceCapture,
  ): Promise<void> {
    const known = this.knownChildren.get(request.threadId);
    // Root turns and non-durable/sessionless registrations have no child locator.
    if (!known?.parent.assignmentStore) {
      return;
    }
    const state = known.parent;
    const child = this.currentChild(request.threadId);
    const current = child?.nativeTurnId === request.turnId ? child : undefined;
    const pending = known.pendingTurns.find((turn) => turn.turnId === request.turnId);
    const owner = current?.historyOwner ?? state.historyOwner;
    if (!owner || (!current && !pending?.modelSource)) {
      throw new Error("Native model execution has no exact assignment owner.");
    }
    const assertCurrent = () => {
      request.signal?.throwIfAborted();
      capture.assertCurrent();
      if (
        this.disposed ||
        this.retiredParentStates.has(state) ||
        this.parentStates.get(state.parentThreadId) !== state ||
        this.knownChildren.get(request.threadId) !== known ||
        (current
          ? this.currentChild(request.threadId) !== current ||
            current.terminal ||
            current.settledWithoutCompletion ||
            current.nativeTurnId !== request.turnId
          : !pending || !known.pendingTurns.includes(pending) || !pending.modelSource)
      ) {
        throw new Error("Native model execution assignment changed before admission.");
      }
    };
    assertCurrent();
    await this.assignments.recordExecution(
      state,
      {
        runId: current?.runId ?? codexNativeSubagentRunId(request.threadId, request.turnId),
        childThreadId: request.threadId,
        nativeTurnId: request.turnId,
        nativeParentThreadId: known.nativeParentThreadId,
        owner,
      },
      assertCurrent,
    );
    assertCurrent();
  }

  resolveModelThreadId(turnId: string): string | undefined {
    return resolveNativeModelThreadId(
      turnId,
      this.parentStates,
      this.knownChildren,
      this.childStates,
      (state) => !this.disposed && !this.retiredParentStates.has(state),
    );
  }

  prepareModelInput(request: NativeModelToolInputRequest): Promise<void> {
    return prepareNativeModelToolInput(request, {
      client: this.client,
      parents: this.parentStates,
      children: this.childStates,
      knownChildren: this.knownChildren,
      isCurrent: (state) => this.isCurrentParent(state),
      interruptModelExecution: this.interruptModelExecution,
      retainTargetRevision: (threadId) => this.recovery.retainThreadStatusRevision(threadId),
      currentModelExecution: (threadId) =>
        currentNativeModelExecution(
          threadId,
          this.parentStates,
          this.knownChildren,
          this.childStates,
        ),
      admissions: this.admissionCustody.entries,
      prepareReceiver: (state, threadId, nativeParentThreadId) =>
        this.prepareReceiverChild(state, threadId, nativeParentThreadId),
      registerChildThread: (state, threadId, options) =>
        this.registerChildThread(state, threadId, options),
      admit: (state, owner, input, count, preparedOwner) =>
        this.submissions.admitModelInput(state, owner, input, count, preparedOwner),
    });
  }

  releasePendingModelInputs(threadId: string): void {
    this.submissions.retireReceiverModelInputs(threadId);
    releasePendingNativeModelInputs(threadId, this.admissionCustody.entries);
    this.clearUnconsumablePendingChildAdmissionEvidence();
    notifyNativeModelSourceChange("thread/closed", this.parentStates.values());
  }

  retireParent(parentThreadIdInput: string): void {
    const current = this.parentStates.get(parentThreadIdInput.trim());
    const states = current ? this.requesterParents(current) : [];
    // Revoke the whole captured lineage before cleanup can admit another completion.
    for (const state of states) {
      this.retiredParentStates.add(state);
    }
    for (const state of states) {
      const parentThreadId = state.parentThreadId;
      this.submissions.retire(state);
      for (const owner of state.owners.values()) {
        releaseCompletionCustody(owner);
      }
      releaseNativeParentModelSources(state, this.knownChildren.values());
      state.owners.clear();
      this.childCloses.clear(state);
      this.admissionCustody.retainOnly((evidence) => evidence.parentThreadId !== parentThreadId);
      for (const childState of Array.from(this.childStates.values())) {
        if (childState.parentThreadId === parentThreadId) {
          this.childCloses.retireChild(state, childState);
        }
      }
      this.pruneParentIfUnused(state);
      notifyNativeModelSourceWaiters(state);
    }
  }

  private async handleNotification(notification: CodexServerNotification): Promise<void> {
    if (this.disposed) {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const revisedThreadId =
      readString(params, "threadId") ??
      (isJsonObject(params?.thread) ? readString(params.thread, "id") : undefined);
    if (
      revisedThreadId &&
      (RECOVERY_REVISION_NOTIFICATION_METHODS.has(notification.method) ||
        notification.method === "thread/closed")
    ) {
      this.recovery.observeRevision(revisedThreadId);
    }
    if (notification.method === "thread/closed") {
      const closedThreadId = readString(params, "threadId");
      if (closedThreadId) {
        this.releasePendingModelInputs(closedThreadId);
      }
      closeNativeModelChild(
        readString(params, "threadId"),
        this.knownChildren,
        this.childStates,
        (state) => this.pruneParentIfUnused(state),
      );
      return;
    }
    if (
      notification.method === "turn/started" &&
      params &&
      !this.observeNativeChildTurnStart(params)
    ) {
      return;
    }
    if (notification.method === "turn/completed" && params) {
      const known = this.knownChildren.get(readString(params, "threadId") ?? "");
      const turn = isJsonObject(params.turn) ? params.turn : undefined;
      const turnId = readString(turn, "id");
      const pending = known?.pendingTurns.find((candidate) => candidate.turnId === turnId);
      if (pending) {
        pending.state = readNativeTurnEnd(turn);
      }
    }
    if (
      params &&
      (notification.method === "turn/started" || notification.method === "turn/completed") &&
      isJsonObject(params.turn)
    ) {
      this.submissions.observeTurn(readString(params, "threadId") ?? "", params.turn);
    }
    if (
      notification.method === "rawResponseItem/completed" &&
      params &&
      isJsonObject(params.item)
    ) {
      const parent = this.resolveNativeParentState(readString(params, "threadId") ?? "");
      if (parent) {
        this.submissions.observeOutput(parent, readString(params, "turnId"), params.item);
      }
    }
    const mirrorState = this.resolveMirrorState(notification);
    const startedThread = isJsonObject(params?.thread) ? params.thread : undefined;
    const threadId =
      readString(params, "threadId")?.trim() ?? readString(startedThread, "id")?.trim();
    const threadStatus = isJsonObject(params?.status)
      ? normalizeIdentifier(readString(params.status, "type"))
      : undefined;
    const parent = threadId ? this.parentStates.get(threadId) : undefined;
    if (parent) {
      observeNativeParentTurn(
        parent,
        notification.method,
        isJsonObject(params?.turn) ? readString(params.turn, "id") : undefined,
      );
    }
    const tracksRecoveryRevision = Boolean(threadId && this.recovery.hasRevision(threadId));
    if (
      !mirrorState &&
      (!threadId ||
        (!this.parentStates.has(threadId) &&
          !this.currentChild(threadId) &&
          !tracksRecoveryRevision))
    ) {
      return;
    }
    const notificationTurnId =
      readString(params, "turnId") ??
      (isJsonObject(params?.turn) ? readString(params.turn, "id") : undefined);
    const pendingTurns = threadId ? this.knownChildren.get(threadId)?.pendingTurns : undefined;
    const pendingNativeTurn = pendingTurns?.some(
      (pending) => !notificationTurnId || pending.turnId === notificationTurnId,
    );
    if (pendingNativeTurn && threadId) {
      const previous = this.currentChild(threadId);
      if (previous) {
        void this.recovery.reconcileRegisteredChild(previous).catch((error: unknown) => {
          logRecoveryFailure(threadId, error);
          this.recovery.scheduleRecoveryPoll(previous);
        });
      }
    }
    const isChildClose = isCodexNativeSubagentCloseNotification(notification);
    if (mirrorState && isChildClose) {
      await this.childCloses.observe(notification, mirrorState);
    }
    const childState = threadId && !pendingNativeTurn ? this.currentChild(threadId) : undefined;
    if (notification.method === "turn/started" && childState) {
      childState.nativeCompletionDelivered = false;
      this.resumeChild(childState);
    }
    if (parent && parent.turnIds.has(readString(params, "turnId") ?? "")) {
      observeCodexNativeSubagentDeliveryReceipts({
        state: parent,
        notification,
        knownChildren: this.knownChildren.values(),
        applyReceipts: (runIds) => this.applyNativeReceipts(parent, runIds),
      });
    }
    if (
      childState &&
      !childState.terminal &&
      (!pendingTurns?.length || notification.method === "turn/completed")
    ) {
      this.turnObservation.emitChildTaskActivity(notification, childState);
    }
    if (!pendingNativeTurn) {
      await this.handleChildTurnCompletion(notification, childState);
    }
    if (
      !pendingNativeTurn &&
      notification.method === "thread/status/changed" &&
      threadId &&
      threadStatus
    ) {
      if (threadStatus !== "systemerror") {
        if (childState) {
          this.recovery.clearSystemErrorFallback(childState);
        }
      } else {
        if (childState) {
          this.resumeChild(childState, { scheduleRecovery: false });
          this.recovery.setRecoveryFallback(
            childState,
            systemErrorFallbackCompletion(childState.childThreadId),
            this.now(),
          );
        }
        void this.reconcileChildThread(threadId)
          .catch((error: unknown) => {
            logRecoveryFailure(threadId, error);
            return false;
          })
          .then((reconciled) => {
            if (!reconciled && childState && this.currentChild(threadId) === childState) {
              this.recovery.scheduleRecoveryPoll(childState);
            }
          });
      }
    }
    await this.handleCompletionNotification(notification);
  }

  private resumeChild(childState: ChildState, options: { scheduleRecovery?: boolean } = {}): void {
    if (childState.terminal) {
      return;
    }
    this.observeActiveChild(childState);
    this.recovery.clearRecoveryTimers(childState);
    childState.recoveryAttempt = 0;
    if (options.scheduleRecovery !== false) {
      this.recovery.scheduleRecoveryPoll(childState);
    }
  }

  private observeActiveChild(childState: ChildState): void {
    childState.settledWithoutCompletion = false;
    childState.fallbackCompletion = undefined;
    this.releaseClientRetention ??= this.retainClient?.();
  }

  private settleResumableChild(childState: ChildState): void {
    if (childState.terminal) {
      return;
    }
    childState.settledWithoutCompletion = true;
    releaseCompletionCustody(childState);
    childState.emitEvent = undefined;
    childState.fallbackCompletion = undefined;
    releaseNativeDirectChild(childState);
    releaseNativeModelExecution(childState);
    this.recovery.clearRecoveryTimers(childState);
    this.releaseClientRetentionIfIdle();
  }

  private async handleChildTurnCompletion(
    notification: CodexServerNotification,
    childState: ChildState | undefined,
  ): Promise<void> {
    if (notification.method !== "turn/completed") {
      return;
    }
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const childThreadId = readString(params, "threadId")?.trim();
    const state = childState ? this.parentStates.get(childState.parentThreadId) : undefined;
    const turn = isJsonObject(params?.turn) ? params.turn : undefined;
    if (
      !state ||
      !childState ||
      childState.childThreadId !== childThreadId ||
      !turn ||
      childState.terminal
    ) {
      return;
    }
    const turnId = readString(turn, "id");
    if (childState.nativeTurnId && turnId !== childState.nativeTurnId) {
      return;
    }
    const status = normalizeIdentifier(readString(turn, "status"));
    if (status === "interrupted") {
      this.removePendingSpawnAdmissionEvidenceForChild(childState.childThreadId);
      this.rejectPendingDirectChild(
        state,
        childState.childThreadId,
        "Codex child turn interrupted",
      );
      this.settleResumableChild(childState);
      return;
    }
    if (status === "completed" || status === "failed") {
      // Completion text may require history recovery, but a terminal child no
      // longer owns executable parent authority while that observation runs.
      const latestTurnId = this.knownChildren.get(childState.childThreadId)?.turnId;
      if (!latestTurnId || latestTurnId === turnId) {
        this.recovery.markTerminalRevision(childState.childThreadId);
        this.rejectPendingDirectChild(
          state,
          childState.childThreadId,
          "Codex child turn completed",
        );
        this.removePendingSpawnAdmissionEvidenceForChild(childState.childThreadId);
      }
      releaseNativeDirectChild(childState);
      releaseNativeModelExecution(childState);
    }
    const completion = readTurnCompletion(turn, childState.childThreadId, "notification");
    if (!completion) {
      return;
    }
    await this.processObservedCompletion(state, childState, completion);
  }

  async reconcileChildThread(childThreadIdInput: string): Promise<boolean> {
    const childState = this.currentChild(childThreadIdInput.trim());
    return childState ? this.recovery.reconcileRegisteredChild(childState) : false;
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readThreadParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readString(readThreadSpawnSource(thread), "agent_path")?.trim();
      const state = parentThreadId ? this.resolveNativeParentState(parentThreadId) : undefined;
      if (state?.preparing) {
        return undefined;
      }
      if (state && childThreadId && parentThreadId) {
        return this.registerChildThread(state, childThreadId, {
          ...(agentPath === undefined ? {} : { agentPath }),
          nativeParentThreadId: parentThreadId,
        })
          ? state
          : undefined;
      }
      return state;
    }
    if (
      notification.method === "thread/status/changed" ||
      notification.method === "turn/started" ||
      notification.method === "turn/completed" ||
      notification.method === "item/agentMessage/delta"
    ) {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId
        ? this.currentChild(childThreadId)?.parentThreadId
        : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.resolveNativeParentState(parentThreadId) : undefined;
      if (state?.preparing) {
        return undefined;
      }
      if (state && parentThreadId) {
        const turnId = readString(params, "turnId");
        const owner = this.resolveParentOwner(state, turnId, parentThreadId);
        if (notification.method === "item/completed") {
          if (
            readString(item, "type") === "subAgentActivity" &&
            readString(item, "kind") === "interacted"
          ) {
            const childThreadId = readString(item, "agentThreadId");
            if (childThreadId) {
              const accept = (admittedOwner: ParentOwner | undefined) =>
                this.observeParentInteraction(
                  state,
                  owner,
                  childThreadId,
                  readString(item, "agentPath"),
                  {
                    parentTurnId: turnId,
                    itemId: readString(item, "id"),
                    modelOwner: admittedOwner,
                  },
                );
              if (
                !this.submissions.acceptInteraction(
                  state,
                  turnId,
                  readString(item, "id"),
                  childThreadId,
                  accept,
                )
              ) {
                accept(owner);
              }
            }
            return state;
          }
          if (
            readString(item, "type") === "collabAgentToolCall" &&
            readString(item, "tool") === "sendInput" &&
            readString(item, "status") === "completed"
          ) {
            this.submissions.observeCall(state, turnId, item!);
            return undefined;
          }
        }
        // Codex multi-agent V2 exposes the child only through this parent-scoped
        // activity item; its later wait item has no receiver thread ids.
        if (
          notification.method === "item/completed" &&
          readString(item, "type") === "subAgentActivity" &&
          normalizeIdentifier(readString(item, "kind")) === "started"
        ) {
          const childThreadId = readString(item, "agentThreadId")?.trim();
          const agentPath = readString(item, "agentPath");
          if (childThreadId) {
            this.registerDirectSpawnChild(
              state,
              turnId,
              {
                parentThreadId: state.parentThreadId,
                nativeParentThreadId: parentThreadId,
                childThreadId,
                ...(agentPath === undefined ? {} : { agentPath }),
              },
              owner,
            );
          }
          return state;
        }
        const isCompletedSpawnAgentTool =
          notification.method === "item/completed" &&
          readString(item, "type") === "collabAgentToolCall" &&
          normalizeIdentifier(readString(item, "tool")) === "spawnagent" &&
          normalizeIdentifier(readString(item, "status")) === "completed";
        if (normalizeIdentifier(readString(item, "tool")) === "closeagent") {
          // closeAgent names an existing child before shutdown; treating its
          // receiver as discovery resurrects completed tasks and repins parents.
          return state;
        }
        if (parentThreadId !== state.parentThreadId && !isCompletedSpawnAgentTool) {
          // Nested waits observe receivers; only accepted spawn/input paths claim them.
          return state;
        }
        // Pinned Codex derives both fields from the spawn ID, but agentsStates is
        // observational status metadata. Only receiverThreadIds is authoritative
        // direct-spawn evidence and may mint retained child authority.
        const childThreadIds = new Set(readNativeSubagentThreadIds(item?.receiverThreadIds));
        let accepted = true;
        for (const childThreadId of childThreadIds) {
          accepted =
            Boolean(
              isCompletedSpawnAgentTool
                ? this.registerDirectSpawnChild(
                    state,
                    turnId,
                    {
                      parentThreadId: state.parentThreadId,
                      nativeParentThreadId: parentThreadId,
                      childThreadId,
                    },
                    owner,
                  )
                : this.registerChildThread(state, childThreadId),
            ) && accepted;
        }
        if (!accepted) {
          return undefined;
        }
      }
      return state;
    }
    return undefined;
  }

  private async handleCompletionNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const parentThreadId = params ? readString(params, "threadId")?.trim() : undefined;
    const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    if (!state) {
      return;
    }
    for (const nativeCompletion of nativeSubagentNotifications.fromNotification(notification)) {
      const childThreadId = this.childThreadIdsByAgentPath.get(
        buildParentAgentPathKey(state.parentThreadId, nativeCompletion.agentPath),
      );
      const childState = childThreadId ? this.currentChild(childThreadId) : undefined;
      if (
        !childState ||
        childState.parentThreadId !== state.parentThreadId ||
        childState.terminal ||
        this.knownChildren.get(childState.childThreadId)?.pendingTurns.length ||
        readCodexNativeSubagentRunId(childState.runId)?.turnId
      ) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion: CodexNativeSubagentCompletion = {
        childThreadId: childState.childThreadId,
        status: nativeCompletion.status,
        statusLabel: nativeCompletion.statusLabel,
        result: nativeCompletion.result,
      };
      await this.processObservedCompletion(state, childState, completion);
    }
  }

  private async processObservedCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
  ): Promise<void> {
    if (!isNoFinalCompletion(completion)) {
      await this.processCompletion(state, childState, completion);
      return;
    }
    this.resumeChild(childState, { scheduleRecovery: false });
    this.recovery.setRecoveryFallback(childState, completion, this.now());
    await this.recovery.reconcileRegisteredChild(childState).catch((error: unknown) => {
      logRecoveryFailure(childState.childThreadId, error);
      return false;
    });
  }

  private async reconcileChildState(childState: ChildState): Promise<boolean> {
    const state = this.parentStates.get(childState.parentThreadId);
    if (!state) {
      return false;
    }
    const statusRead = this.recovery.retainThreadStatusRevision(childState.childThreadId);
    try {
      const recovery = await this.historyRecovery.read(childState, {
        resumeInterrupted: !childState.terminal,
        initialAssignment: childState.recoverInitialAssignment,
        recordedCompletion: childState.pendingCompletion,
      });
      // Notification handlers run concurrently. A later status transition wins
      // over this read so stale history cannot complete or re-arm the child.
      if (!statusRead.isCurrent() || this.childStates.get(childState.runId) !== childState) {
        return false;
      }
      if (childState.completionCustody && !childState.completionCustody.isCurrent()) {
        this.unregisterChild(childState);
        return false;
      }
      if (recovery.parentThreadId && recovery.parentThreadId !== childState.nativeParentThreadId) {
        embeddedAgentLog.warn("Codex native subagent parent did not match monitor state", {
          childThreadId: childState.childThreadId,
          expectedParentThreadId: childState.nativeParentThreadId,
          actualParentThreadId: recovery.parentThreadId,
        });
        this.unregisterChild(childState);
        return false;
      }
      if (recovery.agentPath) {
        this.registerAgentPath(state, childState.childThreadId, recovery.agentPath);
      }
      this.recordRecoveredChildTurn(state, childState, recovery);
      if (recovery.threadState === "active") {
        this.observeActiveChild(childState);
        return false;
      }
      if (recovery.threadState === "other") {
        this.recovery.clearSystemErrorFallback(childState);
      }
      if (recovery.resumable) {
        this.settleResumableChild(childState);
        return false;
      }
      const completion = this.processRecoveredCompletion(state, childState, recovery);
      if (!completion) {
        return false;
      }
      await completion;
      return true;
    } finally {
      statusRead.release();
    }
  }

  private processRecoveredCompletion(
    state: ParentState,
    child: ChildState,
    recovery: ThreadRecovery,
  ): Promise<void> | undefined {
    const completion = recovery.completion;
    if (completion && !isNoFinalCompletion(completion)) {
      return this.processCompletion(state, child, completion, completion.completedAt);
    }
    const fallback = completion ?? recovery.fallbackCompletion;
    if (fallback) {
      this.recovery.setRecoveryFallback(child, fallback, fallback.completedAt ?? this.now());
    }
    return undefined;
  }

  private recordRecoveredChildTurn(
    state: ParentState,
    child: ChildState,
    recovery: ThreadRecovery,
  ): void {
    const known = this.knownChildren.get(child.childThreadId);
    if (known?.parent === state) {
      for (const observed of recovery.observedPendingTurns) {
        const pending = known.pendingTurns.find(
          (candidate) => candidate.turnId === observed.turnId,
        );
        if (pending && observed.state) {
          pending.state =
            observed.state === "active" && pending !== known.pendingTurns.at(-1)
              ? undefined
              : observed.state;
        }
      }
    }
    const turnId = recovery.nativeTurnId;
    if (!turnId) {
      return;
    }
    const observedTurn = Boolean(child.nativeTurnId && child.nativeTurnId !== turnId);
    if (child.nativeTurnId !== turnId) {
      child.nativeTurnId = turnId;
      child.nativeTurnState = undefined;
      child.activityWait = undefined;
    }
    child.nativeTurnState = recovery.nativeTurnState;
    if (child.nativeTurnState && child.nativeTurnState !== "active") {
      releaseNativeDirectChild(child);
    }
    this.recordObservedChildTurn(state, child, observedTurn);
  }

  private recordObservedChildTurn(
    state: ParentState,
    child: ChildState,
    observedTurn = false,
  ): ChildState | undefined {
    const known = this.knownChildren.get(child.childThreadId);
    if (!child.nativeTurnId || known?.parent !== state || known.assignment.runId !== child.runId) {
      return child;
    }
    this.assignments.record(state, child);
    known.assignment.nativeTurnId = child.nativeTurnId;
    known.assignment.unanchored = undefined;
    if (!known.observedTurns.has(child.nativeTurnId)) {
      known.observedTurns.set(
        child.nativeTurnId,
        observedTurn ? { awaitingInteraction: true } : {},
      );
    }
    if (observedTurn && known.pendingTurns.length === 0) {
      this.associatePendingChildInteraction(known, child.childThreadId, child.nativeTurnId);
    }
    this.submissions.observeKnownChild(child.childThreadId);
    return this.admitFollowupChild(known, child.childThreadId);
  }

  private async processCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = this.now(),
  ): Promise<void> {
    if (childState.terminal) {
      return;
    }
    const acceptedCompletion =
      childState.modelExecution?.executionOwner.modelExecutionCancelled ||
      (childState.nativeTurnId && childState.cancelledModelTurnId === childState.nativeTurnId)
        ? ({
            childThreadId: childState.childThreadId,
            status: "cancelled",
            statusLabel: "model_authority_revoked",
            result: "Native model execution authority was revoked.",
          } satisfies CodexNativeSubagentCompletion)
        : completion;
    releaseNativeModelExecution(childState);
    childState.terminal = true;
    const known = this.knownChildren.get(childState.childThreadId);
    if (known?.assignment.runId === childState.runId) {
      known.assignment.terminal = true;
      known.assignment.unanchored = undefined;
      known.assignment.nativeTurnId = childState.nativeTurnId;
    }
    childState.pendingCompletion = { ...acceptedCompletion, completedAt: eventAt };
    this.recovery.markTerminalRevision(childState.childThreadId);
    releaseNativeDirectChild(childState);
    this.recovery.clearRecoveryTimers(childState);
    this.applyNativeReceipts(
      state,
      childState.deliveryReceipts.record(
        childState.runId,
        this.knownChildren.get(childState.childThreadId)?.agentPaths ?? [childState.childThreadId],
        acceptedCompletion.result,
      ),
    );
    await this.completionDelivery.deliverPending(state, childState);
  }

  private applyNativeReceipts(state: ParentState, runIds: readonly string[]): void {
    this.completionDelivery.applyReceipts(state, runIds, this.childStates);
  }

  private resolveChildReceiptOwner(
    state: ParentState,
    childThreadId: string,
  ): CodexNativeSubagentDeliveryReceipts {
    return resolveCodexNativeSubagentReceiptOwner({
      state,
      childThreadId,
      known: this.knownChildren.get(childThreadId),
    });
  }

  private prepareReceiverChild(
    state: ParentState,
    threadId: string,
    nativeParentThreadId?: string,
  ): boolean {
    const known = this.knownChildren.get(threadId);
    if (known?.parent === state) {
      return true;
    }
    if (
      !this.isCurrentParent(state) ||
      (known &&
        (!known.assignment.terminal ||
          known.pendingTurns.length > 0 ||
          this.submissions.hasChildCustody(known.parent, threadId)))
    ) {
      return false;
    }
    if (!known) {
      return true;
    }
    const previous = known.parent;
    if (
      nativeParentThreadId !== known.nativeParentThreadId ||
      this.retiredParentStates.has(previous) ||
      !state.requesterSessionKey ||
      previous.requesterSessionKey !== state.requesterSessionKey ||
      !previous.historyOwner ||
      !state.historyOwner ||
      !matchesNativeAssignmentLifecycle(previous.historyOwner, state.historyOwner) ||
      ![...state.owners.values()].some((owner) => owner.completionCustody?.isCurrent())
    ) {
      return false;
    }
    try {
      state.assignmentStore?.assertCurrent();
    } catch {
      return false;
    }
    // Only admitted input with freshly read lineage can transfer observation.
    // Earlier results retain their original child state, custody, and receipts.
    known.parent = state;
    for (const agentPath of known.agentPaths) {
      this.registerAgentPath(state, threadId, agentPath);
    }
    return true;
  }

  private registerChildThread(
    state: ParentState,
    childInput: string | NativeSubagentAssignment,
    options: {
      admitAssignment?: true;
      agentPath?: string;
      directOwner?: ParentOwner;
      nativeParentThreadId?: string;
      completionCustody?: AgentHarnessCompletionCustody;
      historyOwner?: ParentState["historyOwner"];
      observedTurns?: readonly NativeTurnObservation[];
    } = {},
  ): ChildState | undefined {
    const parentThreadId = state.parentThreadId;
    const preparedAssignment = typeof childInput === "string" ? undefined : childInput;
    const childThreadId =
      typeof childInput === "string" ? childInput.trim() : childInput.childThreadId;
    if (!parentThreadId || !childThreadId || this.disposed || state.preparing) {
      return undefined;
    }
    const claimDirectChild = options.directOwner?.claimDirectChild;
    if (claimDirectChild && this.recovery.isTerminalRevision(childThreadId)) {
      // A late spawn event is observational only after this client has seen
      // the child's terminal state; it must not recreate direct authority.
      return undefined;
    }
    if (!preparedAssignment && !this.prepareReceiverChild(state, childThreadId)) {
      return undefined;
    }
    const known = this.knownChildren.get(childThreadId);
    const observedTurns = options.observedTurns ?? [];
    if (known && known.parent !== state) {
      embeddedAgentLog.warn("Ignoring Codex native subagent child reparenting", {
        childThreadId,
        existingParentThreadId: known.parent.parentThreadId,
        attemptedParentThreadId: parentThreadId,
      });
      return undefined;
    }
    const assignment = preparedAssignment ?? {
      runId: known?.assignment.runId ?? codexNativeSubagentRunId(childThreadId),
      childThreadId,
      nativeTurnId: undefined,
    };
    const { runId } = assignment;
    let childState = this.childStates.get(runId);
    if (childState && childState.parentThreadId !== parentThreadId) {
      return undefined;
    }
    if (!childState && known && !preparedAssignment) {
      // Reading an old receiver does not start another assignment.
      return undefined;
    }
    if (!childState) {
      this.updateChildThreadOwnership("claim", childThreadId, this.claimChildThread);
      this.releaseClientRetention ??= this.retainClient?.();
      if (!this.parentThreadRetentions.has(parentThreadId)) {
        const releaseParentThread = this.retainParentThread?.(parentThreadId);
        if (releaseParentThread) {
          // Child completion can be announced on its parent's subscription
          // after the foreground parent turn has already released ownership.
          this.parentThreadRetentions.set(parentThreadId, releaseParentThread);
        }
      }
      childState = {
        runId,
        nativeTurnId: assignment.nativeTurnId,
        nativeTurnState: observedTurns.find((turn) => turn.turnId === assignment.nativeTurnId)
          ?.state,
        deliveryReceipts: this.resolveChildReceiptOwner(state, childThreadId),
        childThreadId,
        parentThreadId,
        nativeParentThreadId:
          known?.nativeParentThreadId ?? options.nativeParentThreadId ?? parentThreadId,
        agentId: state.agentId,
        historyOwner: options.historyOwner ?? state.historyOwner,
        recoveryAttempt: 0,
        terminal: false,
        nativeCompletionDelivered: false,
        settledWithoutCompletion: false,
        completionDeliveryAttempt: 0,
        deliveringCompletion: false,
      };
      this.childStates.set(runId, childState);
      if (
        !known ||
        (!known.assignment.nativeTurnId && assignment.nativeTurnId && observedTurns.length > 0)
      ) {
        this.restoreKnownChild(state, assignment, observedTurns);
      }
      this.recovery.seedRevision(childThreadId, parentThreadId);
    }
    if (known && options.admitAssignment) {
      const previousRunId = known.assignment.runId;
      known.assignment = {
        ...assignment,
        terminal:
          childState.terminal || (known.assignment.runId === runId && known.assignment.terminal),
      };
      if (previousRunId !== runId) {
        this.refreshWaitDependency(state, childThreadId);
      }
    }
    if (
      claimDirectChild &&
      !childState.terminal &&
      !childState.settledWithoutCompletion &&
      !childState.releaseDirectChild
    ) {
      childState.directOwner = options.directOwner;
      childState.releaseDirectChild = claimDirectChild(childThreadId);
    }
    // Execution relay custody ends before completion; retain the admitting source independently.
    childState.completionCustody ??= (
      options.completionCustody ?? options.directOwner?.completionCustody
    )?.retain();
    this.admissionCustody.bindEventSink(childState);
    this.registerAgentPath(state, childThreadId, childThreadId);
    const agentPath = normalizeOptionalString(options.agentPath);
    if (agentPath) {
      this.registerAgentPath(state, childThreadId, agentPath);
    }
    for (const path of this.knownChildren.get(childThreadId)?.agentPaths ?? []) {
      this.registerAgentPath(state, childThreadId, path);
    }
    this.applyNativeReceipts(
      state,
      childState.deliveryReceipts.track(
        runId,
        this.knownChildren.get(childThreadId)?.agentPaths ?? [childThreadId],
      ),
    );
    const restored = this.knownChildren.get(childThreadId);
    if (restored && !known && options.nativeParentThreadId) {
      restored.nativeParentThreadId = options.nativeParentThreadId;
    }
    if (observedTurns.length > 0 && restored?.parent === state) {
      if (!restored.assignment.terminal && !this.currentChild(childThreadId)) {
        this.registerChildThread(state, restored.assignment, { observedTurns });
      }
      const pendingAdmissions = [...this.admissionCustody.entries];
      for (const [parentTurnId, pending] of pendingAdmissions) {
        const owners = new Set<ParentOwner>();
        for (const entry of pending) {
          if (
            entry.kind !== "interaction" ||
            entry.parentThreadId !== state.parentThreadId ||
            entry.childThreadId !== childThreadId
          ) {
            continue;
          }
          const owner = entry.admittedOwner ?? entry.owner;
          if (owner) {
            owners.add(owner);
          }
        }
        for (const owner of owners) {
          this.drainPendingChildAdmissionEvidence(state, owner, parentTurnId, true);
        }
      }
    }
    this.assignments.record(state, childState);
    this.recovery.scheduleRecoveryPoll(childState);
    return childState;
  }

  private currentChild(threadId: string): ChildState | undefined {
    const runId = this.knownChildren.get(threadId)?.assignment.runId;
    return runId ? this.childStates.get(runId) : undefined;
  }

  private isCurrentParent(state: ParentState): boolean {
    return (
      !this.disposed &&
      !this.retiredParentStates.has(state) &&
      this.parentStates.get(state.parentThreadId) === state
    );
  }

  private refreshWaitDependency(state: ParentState, receiverThreadId: string): void {
    if (!this.isCurrentParent(state)) {
      return;
    }
    for (const child of this.childStates.values()) {
      if (child.parentThreadId === state.parentThreadId) {
        this.turnObservation.refreshWaitDependency(child, receiverThreadId);
      }
    }
  }

  private observeNativeChildTurnStart(params: JsonObject): boolean {
    const threadId = readString(params, "threadId");
    const turn = isJsonObject(params.turn) ? params.turn : undefined;
    const turnId = readString(turn, "id");
    const known = threadId ? this.knownChildren.get(threadId) : undefined;
    if (
      !threadId ||
      !turnId ||
      !known ||
      this.parentStates.get(known.parent.parentThreadId) !== known.parent
    ) {
      return true;
    }
    let previous = this.currentChild(threadId);
    if (!previous && !known.assignment.terminal) {
      previous = this.registerChildThread(known.parent, known.assignment);
    }
    const pending = known.pendingTurns.find((candidate) => candidate.turnId === turnId);
    if (pending) {
      pending.state = "active";
    }
    if (
      known.observedTurns.has(turnId) &&
      (known.turnId !== turnId ||
        known.assignment.terminal ||
        pending ||
        previous?.nativeTurnState !== undefined)
    ) {
      return false;
    }
    const observedTurn = !known.observedTurns.has(turnId);
    const startsPendingTurn =
      !pending &&
      (known.pendingTurns.length > 0 ||
        known.assignment.unanchored ||
        !previous ||
        known.assignment.terminal ||
        previous.terminal ||
        previous.nativeTurnState === "completed" ||
        previous.nativeTurnState === "failed" ||
        (previous.nativeTurnId && previous.nativeTurnId !== turnId));
    if (observedTurn) {
      known.observedTurns.set(turnId, startsPendingTurn ? { awaitingInteraction: true } : {});
    }
    if (startsPendingTurn) {
      const previousPending = known.pendingTurns.at(-1);
      if (previousPending?.state === "active") {
        previousPending.state = undefined;
      }
      known.pendingTurns.push({ turnId, state: "active" });
      if (
        !previousPending &&
        previous &&
        !known.assignment.terminal &&
        !previous.terminal &&
        (!previous.nativeTurnState || previous.nativeTurnState === "active")
      ) {
        previous.nativeTurnState = undefined;
        previous.activityWait = undefined;
        releaseNativeDirectChild(previous);
        this.turnObservation.markActivityUnknown(previous);
      }
      this.applyNativeReceipts(
        known.parent,
        known.deliveryReceipts.track(codexNativeSubagentRunId(threadId, turnId), known.agentPaths),
      );
    }
    known.turnId = turnId;
    if (previous && !previous.terminal && known.pendingTurns.length === 0) {
      previous.nativeTurnId = turnId;
      known.assignment.nativeTurnId = turnId;
      known.assignment.unanchored = undefined;
      previous.nativeTurnState = "active";
      this.assignments.record(known.parent, previous);
      if (previous.modelExecution && !previous.modelExecution.executionOwner.turnId) {
        previous.modelExecution.bindTurn(turnId);
      }
    }
    if (observedTurn) {
      this.associatePendingChildInteraction(known, threadId, turnId);
    }
    this.admitFollowupChild(known, threadId);
    return true;
  }

  private associatePendingChildInteraction(
    known: KnownChild,
    threadId: string,
    nativeTurnId: string,
  ): void {
    associateNativeChildInteraction(
      known,
      threadId,
      nativeTurnId,
      this.admissionCustody.entries,
      (owner, turnId) => this.drainPendingChildAdmissionEvidence(known.parent, owner, turnId),
    );
  }

  private observeParentInteraction(
    state: ParentState,
    owner: ParentOwner | undefined,
    threadId: string,
    agentPath?: string,
    interaction: {
      parentTurnId?: string;
      itemId?: string;
      modelSourceTurnId?: string;
      modelOwner?: ParentOwner;
    } = {},
  ): void {
    this.prepareReceiverChild(state, threadId);
    const known = this.knownChildren.get(threadId);
    const admissionOwner = owner ?? interaction.modelOwner;
    const unqualified =
      admissionOwner?.unqualifiedModelExecution &&
      !admissionOwner.modelExecutionSettled &&
      !admissionOwner.modelExecutionCancelled;
    if ((known && known.parent !== state) || (!known && !unqualified)) {
      return;
    }
    if (known && interaction.modelOwner?.nativeInputConfiguration) {
      known.configurationQualification = interaction.modelOwner.configurationQualification;
    }
    if (known && agentPath) {
      this.registerAgentPath(state, threadId, agentPath);
    }
    const parentTurnId = interaction.parentTurnId ?? admissionOwner?.turnId;
    this.admissionCustody.buffer(parentTurnId, {
      kind: "interaction",
      parentThreadId: state.parentThreadId,
      childThreadId: threadId,
      ...(agentPath ? { agentPath } : {}),
      ...(interaction.itemId ? { itemId: interaction.itemId } : {}),
      ...(interaction.modelSourceTurnId
        ? { modelSourceTurnId: interaction.modelSourceTurnId }
        : {}),
      ...(owner ? { owner } : {}),
      ...(interaction.modelOwner ? { modelOwner: interaction.modelOwner } : {}),
    });
    if (!known && unqualified) {
      admissionOwner.onDirectChildAccepted?.();
    }
    if (admissionOwner && parentTurnId) {
      this.drainPendingChildAdmissionEvidence(state, admissionOwner, parentTurnId, true);
    }
  }

  private admitFollowupChild(
    known: KnownChild,
    threadId: string,
    owner?: ParentOwner,
  ): ChildState | undefined {
    if (
      this.parentStates.get(known.parent.parentThreadId) !== known.parent ||
      this.retiredParentStates.has(known.parent)
    ) {
      return undefined;
    }
    let child = this.currentChild(threadId);
    if (!child && !known.assignment.terminal) {
      return undefined;
    }
    let claimOwner = owner;
    let transitioned = false;
    while (known.pendingTurns.length > 0) {
      const pending = known.pendingTurns[0]!;
      const currentTurnId = child?.nativeTurnId;
      const recoveredIndex = currentTurnId
        ? known.pendingTurns.findIndex((candidate) => candidate.turnId === currentTurnId)
        : -1;
      if (
        child &&
        !child.terminal &&
        !known.assignment.terminal &&
        (recoveredIndex >= 0 || child.nativeTurnState === "interrupted")
      ) {
        // History may traverse several interrupted continuations at once. Remove
        // every covered provisional boundary before any receipt matching resumes.
        let continuationCount = Math.max(1, recoveredIndex + 1);
        if (recoveredIndex < 0) {
          while (
            continuationCount < known.pendingTurns.length &&
            known.pendingTurns[continuationCount - 1]?.state === "interrupted"
          ) {
            continuationCount += 1;
          }
        }
        const continuations = known.pendingTurns.splice(0, continuationCount);
        const resumed = continuations.at(-1)!;
        child.completionCustody ??= resumed.completionCustody?.retain();
        continuations.forEach(releaseCompletionCustody);
        if (recoveredIndex < 0) {
          child.nativeTurnId = resumed.turnId;
          child.nativeTurnState = resumed.state;
          child.activityWait = undefined;
        }
        claimOwner = resumed.admittedOwner;
        if (resumed.modelSource) {
          releaseNativeModelExecution(child);
          child.modelExecution = resumed.modelSource;
          resumed.modelSource = undefined;
        }
        for (const continuation of continuations) {
          continuation.modelSource?.release();
        }
        transitioned = true;
        this.applyNativeReceipts(
          known.parent,
          known.deliveryReceipts.resumeAssignment(
            child.runId,
            continuations.map((turn) => codexNativeSubagentRunId(threadId, turn.turnId)),
          ),
        );
        continue;
      }
      if (
        child &&
        !child.terminal &&
        !known.assignment.terminal &&
        child.nativeTurnState !== "completed" &&
        child.nativeTurnState !== "failed"
      ) {
        child.nativeTurnState = undefined;
        return undefined;
      }
      if (!pending.admittedOwner && !pending.admittedSubmission && !pending.modelSource) {
        return undefined;
      }
      const runId = codexNativeSubagentRunId(threadId, pending.turnId);
      child = this.registerChildThread(
        known.parent,
        { runId, childThreadId: threadId, nativeTurnId: pending.turnId },
        { admitAssignment: true, completionCustody: pending.completionCustody },
      );
      if (!child) {
        return undefined;
      }
      child.nativeTurnId = pending.turnId;
      child.nativeTurnState = pending.state;
      if (pending.modelSource) {
        releaseNativeModelExecution(child);
        child.modelExecution = pending.modelSource;
        pending.modelSource = undefined;
      }
      claimOwner = pending.admittedOwner;
      transitioned = true;
      known.pendingTurns.shift();
      releaseCompletionCustody(pending);
    }
    if (!child || child.terminal || known.assignment.terminal || !child.nativeTurnId) {
      return undefined;
    }
    this.assignments.record(known.parent, child);
    known.assignment.nativeTurnId = child.nativeTurnId;
    known.turnId = child.nativeTurnId;
    if (child.nativeTurnState !== "active") {
      return child;
    }
    const currentInteraction = [...this.admissionCustody.entries.values()]
      .flat()
      .findLast(
        (evidence) =>
          evidence.kind === "interaction" &&
          evidence.parentThreadId === known.parent.parentThreadId &&
          evidence.childThreadId === threadId &&
          !evidence.nativeTurnId &&
          evidence.owner &&
          [...known.parent.owners.values()].includes(evidence.owner),
      );
    if (currentInteraction?.kind === "interaction" && currentInteraction.owner) {
      claimOwner = currentInteraction.owner;
    }
    if (claimOwner && [...known.parent.owners.values()].includes(claimOwner)) {
      child.completionCustody ??= claimOwner.completionCustody?.retain();
      if (child.directOwner !== claimOwner) {
        releaseNativeDirectChild(child);
        child.directOwner = claimOwner;
        child.releaseDirectChild = claimOwner.claimDirectChild?.(child.childThreadId);
      }
      if (!transitioned) {
        claimOwner.onDirectChildAccepted?.();
      }
    }
    this.admissionCustody.bindEventSink(child);
    return child;
  }

  private resolveParentOwner(
    state: ParentState,
    turnIdInput: string | undefined,
    nativeParentThreadId = state.parentThreadId,
  ): ParentOwner | undefined {
    return resolveNativeModelParentOwner(
      state,
      turnIdInput,
      nativeParentThreadId,
      this.childStates,
      this.knownChildren,
    );
  }

  private resolveNativeParentState(threadId: string): ParentState | undefined {
    return this.parentStates.get(threadId) ?? this.knownChildren.get(threadId)?.parent;
  }

  private registerDirectSpawnChild(
    state: ParentState,
    turnIdInput: string | undefined,
    evidence: DirectSpawnEvidence,
    owner: ParentOwner | undefined,
  ): ChildState | undefined {
    return this.admissionCustody.registerDirectSpawnChild(turnIdInput, evidence, owner, (options) =>
      this.registerChildThread(state, evidence.childThreadId, options),
    );
  }

  private drainPendingChildAdmissionEvidence(
    state: ParentState,
    owner: ParentOwner,
    turnId: string,
    observeActivity = false,
  ): void {
    drainNativeChildModelAdmissions(state, owner, turnId, observeActivity, {
      admissions: this.admissionCustody.entries,
      replaceAdmissions: (parentTurnId, remaining) =>
        this.admissionCustody.replace(parentTurnId, remaining),
      knownChildren: this.knownChildren,
      isCurrent: (parent) =>
        this.parentStates.get(parent.parentThreadId) === parent &&
        !this.retiredParentStates.has(parent),
      currentChild: (threadId) => this.currentChild(threadId),
      registerAgentPath: (parent, threadId, path) => this.registerAgentPath(parent, threadId, path),
      registerChildThread: (parent, threadId, options) =>
        this.registerChildThread(parent, threadId, options),
      admitFollowupChild: (known, threadId, admittedOwner) =>
        this.admitFollowupChild(known, threadId, admittedOwner),
      observeActivity: (child) =>
        this.turnObservation.emitChildTaskActivity(
          {
            method: "turn/started",
            params: { threadId: child.childThreadId, turn: { id: child.nativeTurnId! } },
          },
          child,
        ),
    });
  }

  private clearUnconsumablePendingChildAdmissionEvidence(): void {
    this.admissionCustody.prune((state) => this.retiredParentStates.has(state));
  }

  private removePendingSpawnAdmissionEvidenceForChild(childThreadId: string): void {
    this.admissionCustody.retainOnly(
      (evidence) => evidence.childThreadId !== childThreadId || evidence.kind === "interaction",
    );
  }

  private registerAgentPath(state: ParentState, childThreadId: string, agentPath: string): void {
    this.applyNativeReceipts(
      state,
      registerCodexNativeSubagentReceiptAlias({
        state,
        childThreadId,
        agentPath,
        known: this.knownChildren.get(childThreadId),
        aliases: this.childThreadIdsByAgentPath,
      }),
    );
  }

  private unregisterChild(
    childState: ChildState,
    options: { retainSubscription?: boolean } = {},
  ): void {
    releaseNativeDirectChild(childState);
    releaseNativeModelExecution(childState);
    const known = this.knownChildren.get(childState.childThreadId);
    if (
      childState.terminal &&
      !childState.subscriptionClosed &&
      options.retainSubscription !== false &&
      !this.disposed &&
      known?.parent.parentThreadId === childState.parentThreadId &&
      known.assignment.runId === childState.runId
    ) {
      // Completed Codex children intentionally remain reusable. Transfer their
      // auto-subscription into the shared bounded warm-thread owner, not oblivion.
      this.updateChildThreadOwnership("retain", childState.childThreadId, this.retainChildThread);
    }
    this.recovery.clearRecoveryTimers(childState);
    this.completionDelivery.release(childState);
    if (this.childStates.get(childState.runId) === childState) {
      this.childStates.delete(childState.runId);
    }
    if (
      ![...this.childStates.values()].some(
        (remainingChild) => remainingChild.parentThreadId === childState.parentThreadId,
      )
    ) {
      const releaseParentThread = this.parentThreadRetentions.get(childState.parentThreadId);
      this.parentThreadRetentions.delete(childState.parentThreadId);
      releaseParentThread?.();
    }
    this.recovery.collectThreadStatusRevision(childState.childThreadId);
    this.releaseClientRetentionIfIdle();
    const state = this.parentStates.get(childState.parentThreadId);
    if (state) {
      this.submissions.settleChild(state, childState);
      this.assignments.settle(state, childState);
      this.pruneParentIfUnused(state);
    }
    if (known && known.parent !== state) {
      this.pruneParentIfUnused(known.parent);
    }
  }

  private rejectPendingDirectChild(
    state: ParentState,
    childThreadId: string,
    reason: string,
  ): void {
    if (
      [...this.admissionCustody.entries.values()]
        .flat()
        .some(
          (evidence) =>
            evidence.kind === "interaction" &&
            evidence.parentThreadId === state.parentThreadId &&
            evidence.childThreadId === childThreadId,
        )
    ) {
      // The ended turn cannot reject hooks waiting for an accepted follow-up.
      return;
    }
    for (const owner of state.owners.values()) {
      owner.rejectPendingDirectChild?.(childThreadId, reason);
    }
  }

  private updateChildThreadOwnership(
    operation: "claim" | "retain" | "release",
    childThreadId: string,
    update: ((threadId: string) => Promise<unknown>) | undefined,
  ): void {
    if (!update) {
      return;
    }
    void update(childThreadId).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to update Codex native subagent thread ownership", {
        operation,
        childThreadId,
        error: formatErrorMessage(error),
      });
    });
  }

  private releaseClientRetentionIfIdle(): void {
    if (
      [...this.childStates.values()].some(
        (childState) => !childState.terminal && !childState.settledWithoutCompletion,
      )
    ) {
      return;
    }
    this.releaseRetainedClient();
  }

  private releaseRetainedClient(): void {
    const release = this.releaseClientRetention;
    this.releaseClientRetention = undefined;
    release?.();
  }

  private requesterParents(source: ParentState): ParentState[] {
    return [...this.parentStates.values()].filter(
      (state) =>
        state === source ||
        Boolean(
          source.requesterSessionKey &&
          state.requesterSessionKey === source.requesterSessionKey &&
          state.agentId === source.agentId &&
          source.historyOwner &&
          state.historyOwner &&
          matchesNativeAssignmentLifecycle(source.historyOwner, state.historyOwner),
        ),
    );
  }

  private hasParentWork(state: ParentState): boolean {
    if (
      state.modelSourceReferences ||
      (state.pendingRegistrations && !this.disposed && !this.retiredParentStates.has(state))
    ) {
      return true;
    }
    if (this.assignments.hasWrites(state) || this.submissions.hasCustody(state)) {
      return true;
    }
    if (state.owners.size > 0) {
      return true;
    }
    if (this.childCloses.hasPending(state)) {
      return true;
    }
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === state.parentThreadId) {
        return true;
      }
    }
    for (const known of this.knownChildren.values()) {
      if (known.parent === state && this.currentChild(known.assignment.childThreadId)) {
        return true;
      }
    }
    return false;
  }

  private pruneParentIfUnused(source: ParentState): void {
    if (this.parentStates.get(source.parentThreadId) !== source) {
      return;
    }
    const states = this.requesterParents(source);
    // Keep idle rotated registrations as retirement locators until their
    // requester's retained child, model, or accepted write owners settle.
    if (states.some((state) => this.hasParentWork(state))) {
      return;
    }
    for (const state of states) {
      this.submissions.retire(state);
      this.childCloses.clear(state);
      this.recovery.clearTerminalRevisionsForParent(state.parentThreadId);
      this.parentStates.delete(state.parentThreadId);
      for (const [threadId, known] of this.knownChildren) {
        if (known.parent === state) {
          this.childCloses.retireReceiver(known, () =>
            this.updateChildThreadOwnership("release", threadId, this.releaseChildThread),
          );
          for (const path of known.agentPaths) {
            this.childThreadIdsByAgentPath.delete(
              buildParentAgentPathKey(state.parentThreadId, path),
            );
          }
          this.knownChildren.delete(threadId);
          known.pendingTurns.forEach(releaseCompletionCustody);
        }
      }
    }
  }

  private restoreKnownChild(
    state: ParentState,
    assignment: NativeSubagentAssignment,
    observedTurns: readonly NativeTurnObservation[] = [],
  ): void {
    const current = assignment;
    const terminal = false;
    const nativeParentThreadId = state.parentThreadId;
    const currentIndex = observedTurns.findIndex((turn) => turn.turnId === current.nativeTurnId);
    const pendingTurns = observedTurns
      .filter((turn, index) => index > currentIndex && turn.turnId !== current.nativeTurnId)
      .map((turn, index, turns) => ({
        turnId: turn.turnId,
        state: turn.state === "active" && index < turns.length - 1 ? undefined : turn.state,
      }));
    const previous = this.knownChildren.get(assignment.childThreadId);
    const previousRunId = previous?.assignment.runId;
    const retainedPending = previous?.pendingTurns.filter((pending) => pending.modelSource) ?? [];
    const mergedPending: KnownChild["pendingTurns"] = pendingTurns;
    for (const retained of retainedPending) {
      const recovered = mergedPending.find((pending) => pending.turnId === retained.turnId);
      if (recovered) {
        recovered.modelSource = retained.modelSource;
        recovered.completionCustody = retained.completionCustody;
        retained.completionCustody = undefined;
      } else {
        mergedPending.push(retained);
      }
    }
    for (const pending of previous?.pendingTurns ?? []) {
      if (!mergedPending.includes(pending)) {
        releaseCompletionCustody(pending);
      }
    }
    this.knownChildren.set(assignment.childThreadId, {
      configurationQualification: previous?.configurationQualification,
      parent: state,
      nativeParentThreadId:
        this.childStates.get(current.runId)?.nativeParentThreadId ?? nativeParentThreadId,
      deliveryReceipts: this.resolveChildReceiptOwner(state, assignment.childThreadId),
      assignment: {
        ...current,
        terminal,
      },
      turnId: pendingTurns.at(-1)?.turnId ?? current.nativeTurnId,
      observedTurns: new Map(
        [
          ...new Set(
            [current.nativeTurnId, ...observedTurns.map((turn) => turn.turnId)].filter(
              (id): id is string => Boolean(id),
            ),
          ),
        ].map((turnId) => [
          turnId,
          pendingTurns.some((turn) => turn.turnId === turnId) ? { awaitingInteraction: true } : {},
        ]),
      ),
      pendingTurns: mergedPending,
      agentPaths:
        this.knownChildren.get(assignment.childThreadId)?.agentPaths ??
        new Set([assignment.childThreadId]),
    });
    if (previousRunId !== current.runId) {
      this.refreshWaitDependency(state, assignment.childThreadId);
    }
  }
}

export const codexNativeSubagentMonitorRuntime = createCodexNativeSubagentMonitorRuntime(Monitor);

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
