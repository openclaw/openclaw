import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  NativeModelInputRequest,
  NativeModelSourceRequest,
  ParentOwner,
  ParentState,
  NativeSubagentMonitorClient,
} from "./native-subagent-monitor-types.js";
import {
  DEFAULT_RECOVERY_POLL_DELAYS_MS,
  logRecoveryFailure,
  type CodexNativeSubagentRecoveryCoordinator,
} from "./native-subagent-recovery-coordinator.js";
import { delayForAttempt } from "./native-subagent-retry.js";
import {
  admitSubmissionModelInput,
  acceptSubmissionModelInteraction,
  acceptNativeSubmission,
  assertSubmissionModelInputsCurrent,
  hasPendingSubmissionModelInput,
  hasSubmissionCallCustody,
  observeSubmissionCall,
  observeSubmissionPredecessor,
  readObservedSubmissionTurn,
  retireReceiverModelInputs,
  settleSubmissionModelInput,
  type NativeSubmissionCallDependencies,
  pruneSubmissionCalls,
  type NativeSubagentSubmissionCall as SubmissionCall,
} from "./native-subagent-submission-call.js";
import {
  admitCodexNativeSubmissionTurn,
  readCodexNativeSubmissionTurn,
  type NativeSubmissionAdmissionDependencies,
} from "./native-subagent-submission-history.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

type SubmissionCustody = {
  completionCustody?: AgentHarnessCompletionCustody;
  receipt: CodexNativeSubagentSubmission;
  owner?: ParentOwner;
  release: () => void;
  recorded: Promise<void>;
  phase: "captured" | "detached" | "promoting" | "settled";
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
};
type SubmissionDependencies = NativeSubmissionCallDependencies &
  NativeSubmissionAdmissionDependencies & {
    isCurrent: (state: ParentState) => boolean;
    assertPersistenceCurrent: (state: ParentState) => void;
    client: NativeSubagentMonitorClient;
    recovery: CodexNativeSubagentRecoveryCoordinator;
    retain: (state: ParentState, childThreadId: string) => () => void;
    hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean;
    acceptContinuation: (
      state: ParentState,
      owner: ParentOwner,
      childThreadId: string,
      call: SubmissionCall,
      modelOwner?: ParentOwner,
    ) => Promise<void>;
    onSettled: (state: ParentState) => void;
    recoveryPollDelaysMs?: readonly number[];
  };

/** Captures successful native submissions before their turn notifications arrive. */
export class CodexNativeSubagentSubmissionOwner {
  private readonly calls = new Map<ParentState, Map<string, SubmissionCall>>();
  private readonly pending = new Map<ParentState, Map<string, SubmissionCustody>>();
  private readonly writes = new Map<ParentState, Set<Promise<void>>>();
  private readonly pollDelays: readonly number[];
  private disposed = false;

  constructor(private readonly dependencies: SubmissionDependencies) {
    this.pollDelays = dependencies.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
  }

  private isCurrent(state: ParentState): boolean {
    if (this.dependencies.isCurrent(state)) {
      return true;
    }
    this.retire(state);
    this.dependencies.onSettled(state);
    return false;
  }

  private nativeParentThreadId(state: ParentState, childThreadId: string): string {
    const known = this.dependencies.knownChildren.get(childThreadId);
    return known?.parent === state ? known.nativeParentThreadId : state.parentThreadId;
  }

  private isObserving(state: ParentState, custody: SubmissionCustody): boolean {
    if (
      this.disposed ||
      custody.phase === "promoting" ||
      custody.phase === "settled" ||
      !this.isCurrent(state)
    ) {
      return false;
    }
    if (
      custody.phase === "detached" &&
      !this.dependencies.hasObservationBacking?.(
        state.parentThreadId,
        custody.receipt.childThreadId,
      )
    ) {
      this.finishCustody(state, custody);
      return false;
    }
    return true;
  }

  observeCall(state: ParentState, turnId: string | undefined, item: JsonObject): Promise<void> {
    const call = observeSubmissionCall(state, turnId, item, this.calls, this.dependencies, () =>
      this.isCurrent(state),
    );
    if (!call?.preparation) {
      return Promise.resolve();
    }
    const pending = call.preparation.then(
      () => {
        if (!this.isCurrent(state)) {
          return;
        }
        call.preparing = undefined;
        if (call.submissionId) {
          this.accept(state, call);
        }
      },
      (error: unknown) => {
        call.closed = true;
        call.preparing = undefined;
        settleSubmissionModelInput(call, false, this.dependencies);
        call.completionCustody?.release();
        call.completionCustody = undefined;
        throw error;
      },
    );
    return this.track(state, pending);
  }

  admitModelInput(
    state: ParentState,
    owner: ParentOwner,
    request: NativeModelInputRequest,
    pendingModelSources: number,
    preparedOwner?: ParentOwner,
  ): void {
    admitSubmissionModelInput({
      state,
      owner,
      request,
      pendingModelSources,
      preparedOwner,
      calls: this.calls,
      dependencies: this.dependencies,
      isCurrent: () => this.isCurrent(state),
    });
  }

  acceptInteraction(
    state: ParentState,
    turnId: string | undefined,
    itemId: string | undefined,
    threadId: string,
    accept: (owner: ParentOwner) => void,
  ): boolean {
    return acceptSubmissionModelInteraction(
      this.calls.get(state),
      turnId,
      itemId,
      threadId,
      accept,
      this.dependencies,
    );
  }

  hasPendingModelInput(request: NativeModelSourceRequest): boolean {
    return hasPendingSubmissionModelInput(this.calls, request);
  }

  retireReceiverModelInputs(threadId: string): void {
    retireReceiverModelInputs(this.calls, threadId, this.dependencies);
  }

  assertModelInputCurrent(threadId: string, owner: ParentOwner): void {
    assertSubmissionModelInputsCurrent(this.calls.values(), threadId, owner);
  }

  observeOutput(state: ParentState, turnId: string | undefined, item: JsonObject): void {
    if (item.type !== "function_call_output" || !turnId) {
      return;
    }
    const callId = readString(item, "call_id");
    const key = `${turnId}\0${callId ?? ""}`;
    const call = this.calls.get(state)?.get(key);
    if (!call || call.closed) {
      return;
    }
    let output: unknown;
    try {
      output = JSON.parse(readString(item, "output") ?? "");
    } catch {
      /* Failed native calls have no submission receipt. */
    }
    const submissionId = isJsonObject(output)
      ? readString(output, "submission_id")?.trim()
      : undefined;
    if (!submissionId) {
      call.closed = true;
      settleSubmissionModelInput(call, false, this.dependencies);
      return;
    }
    call.submissionId = submissionId;
    this.accept(state, call);
  }

  bind(state: ParentState, turnId: string): void {
    for (const call of this.calls.get(state)?.values() ?? []) {
      if (call.parentTurnId === turnId && call.submissionId) {
        this.accept(state, call);
      }
    }
  }

  restore(state: ParentState, owner: ParentOwner): void {
    try {
      for (const receipt of state.submissionStore?.read() ?? []) {
        const reconciliation = this.capture(
          state,
          receipt,
          undefined,
          false,
          owner.completionCustody,
        );
        if (reconciliation) {
          void this.track(state, reconciliation);
        }
      }
    } catch (error) {
      embeddedAgentLog.warn("Cannot recover native follow-up submission receipts", {
        error: formatErrorMessage(error),
      });
    }
  }

  observeTurn(threadId: string, turn: JsonObject): void {
    const turnId = readString(turn, "id");
    if (!turnId) {
      return;
    }
    this.observeKnownChild(threadId, turn);
    for (const [state, entries] of this.pending) {
      for (const custody of entries.values()) {
        if (custody.receipt.childThreadId === threadId && custody.receipt.submissionId === turnId) {
          this.promote(state, custody, turn);
        }
      }
    }
  }

  hasCustody(state: ParentState): boolean {
    return (
      Boolean(this.pending.get(state)?.size || this.writes.get(state)?.size) ||
      [...(this.calls.get(state)?.values() ?? [])].some((call) =>
        hasSubmissionCallCustody(state, call, this.dependencies.hasObservationBacking),
      )
    );
  }

  hasChildCustody(state: ParentState, childThreadId: string): boolean {
    return (
      [...(this.pending.get(state)?.values() ?? [])].some(
        (entry) => entry.receipt.childThreadId === childThreadId,
      ) ||
      [...(this.calls.get(state)?.values() ?? [])].some(
        (call) =>
          call.targets.some((target) => target.childThreadId === childThreadId) &&
          hasSubmissionCallCustody(state, call, this.dependencies.hasObservationBacking),
      )
    );
  }

  async settleWrites(state: ParentState): Promise<void> {
    while (this.writes.get(state)?.size) {
      await Promise.allSettled(this.writes.get(state)!);
    }
  }

  async drain(state: ParentState): Promise<void> {
    const calls = this.calls.get(state);
    pruneSubmissionCalls(state, calls, this.dependencies);
    if (!calls?.size) {
      this.calls.delete(state);
    }
    await this.settleWrites(state);
    if (state.owners.size === 0) {
      for (const custody of this.pending.get(state)?.values() ?? []) {
        if (custody.phase === "captured") {
          // Accepted input is not an executing task. After its writes settle,
          // observation uses the existing warm-thread lifetime without pinning it.
          custody.phase = "detached";
          custody.owner = undefined;
          custody.release();
        }
        this.isObserving(state, custody);
      }
    }
  }

  retire(state: ParentState): void {
    for (const call of this.calls.get(state)?.values() ?? []) {
      settleSubmissionModelInput(call, false, this.dependencies);
      call.completionCustody?.release();
    }
    this.calls.delete(state);
    for (const custody of this.pending.get(state)?.values() ?? []) {
      custody.phase = "settled";
      if (custody.timer) {
        clearTimeout(custody.timer);
      }
      custody.release();
      custody.completionCustody?.release();
    }
    this.pending.delete(state);
  }

  dispose(): void {
    this.disposed = true;
    for (const state of new Set([...this.pending.keys(), ...this.calls.keys()])) {
      this.retire(state);
    }
  }

  private accept(state: ParentState, call: SubmissionCall): void {
    acceptNativeSubmission(state, call, {
      ...this.dependencies,
      acceptContinuation: (...args) => this.acceptContinuation(...args),
      isCurrent: (parent) => this.isCurrent(parent),
      capture: (parent, receipt, owner, persist) => {
        void this.capture(parent, receipt, owner, persist, call.completionCustody);
      },
      observeKnownChild: (threadId) => this.observeKnownChild(threadId),
    });
  }

  private acceptContinuation(
    ...args: Parameters<SubmissionDependencies["acceptContinuation"]>
  ): void {
    void this.track(args[0], this.dependencies.acceptContinuation(...args)).catch(
      (error: unknown) => logRecoveryFailure(args[0].parentThreadId, error),
    );
  }

  observeKnownChild(threadId: string, turn?: JsonObject): void {
    for (const [state, calls] of this.calls) {
      if (!this.isCurrent(state)) {
        continue;
      }
      for (const call of calls.values()) {
        observeSubmissionPredecessor({
          state,
          call,
          threadId,
          turn,
          known: this.dependencies.knownChildren.get(threadId),
          hasObservationBacking: this.dependencies.hasObservationBacking,
          acceptContinuation: (owner) => this.acceptContinuation(state, owner, threadId, call),
          capture: (receipt, owner) => {
            void this.capture(state, receipt, owner, true, call.completionCustody);
          },
        });
      }
      this.dependencies.onSettled(state);
    }
  }

  private capture(
    state: ParentState,
    receipt: CodexNativeSubagentSubmission,
    owner?: ParentOwner,
    persist = false,
    completionCustody = owner?.completionCustody,
  ): Promise<void> | undefined {
    if (this.disposed || !this.isCurrent(state)) {
      return undefined;
    }
    const entries = this.pending.get(state) ?? new Map<string, SubmissionCustody>();
    const key = `${receipt.parentTurnId}\0${receipt.callId}\0${receipt.childThreadId}`;
    if (entries.has(key)) {
      return undefined;
    }
    // Late anchor resolution preserves the accepted write without repinning a detached parent.
    const foreground = state.owners.size > 0;
    const custody: SubmissionCustody = {
      completionCustody: completionCustody?.retain(),
      receipt: Object.freeze({ ...receipt }),
      owner,
      release: foreground ? this.dependencies.retain(state, receipt.childThreadId) : () => {},
      recorded: Promise.resolve(),
      phase: foreground ? "captured" : "detached",
      attempt: 0,
    };
    entries.set(key, custody);
    this.pending.set(state, entries);
    if (persist && state.submissionStore) {
      custody.recorded = this.track(
        state,
        (async () => {
          try {
            if (
              !(await state.submissionStore!.record(receipt, () =>
                this.dependencies.assertPersistenceCurrent(state),
              ))
            ) {
              throw new Error("Native submission binding changed before receipt persistence.");
            }
          } catch (error) {
            embeddedAgentLog.warn(
              "Accepted native follow-up lost restart protection; retaining local observation",
              { error: formatErrorMessage(error) },
            );
          }
        })(),
      );
    }
    const observed = readObservedSubmissionTurn(
      state,
      receipt.childThreadId,
      receipt.submissionId,
      this.dependencies,
    );
    if (observed) {
      this.promote(state, custody, observed);
    }
    if (custody.phase !== "promoting") {
      // Cold restoration joins this first history handoff; warm events retain background observation.
      return this.reconcile(state, custody);
    }
    return undefined;
  }

  private promote(
    state: ParentState,
    custody: SubmissionCustody,
    turn: JsonObject,
    historyValidated = false,
  ): void {
    if (!this.isObserving(state, custody)) {
      return;
    }
    const previousPhase = custody.phase;
    custody.phase = "promoting";
    if (custody.timer) {
      clearTimeout(custody.timer);
    }
    const consumed = (async () => {
      try {
        if (
          !(await admitCodexNativeSubmissionTurn(
            {
              state,
              receipt: custody.receipt,
              turn,
              owner: custody.owner,
              historyValidated,
              completionCustody: custody.completionCustody,
              isCurrent: () => !this.disposed && this.isCurrent(state),
              nativeParentThreadId: () =>
                this.nativeParentThreadId(state, custody.receipt.childThreadId),
            },
            this.dependencies,
          ))
        ) {
          if (custody.phase === "promoting") {
            custody.phase = previousPhase;
            this.scheduleReconciliation(state, custody);
          }
          return;
        }
        await custody.recorded;
        if (state.submissionStore) {
          try {
            await state.submissionStore.consume(custody.receipt, () =>
              this.dependencies.assertPersistenceCurrent(state),
            );
          } catch (error) {
            embeddedAgentLog.warn(
              "Native follow-up task is persisted but its receipt remains for reconciliation",
              { error: formatErrorMessage(error) },
            );
          }
        }
        this.finishCustody(state, custody);
      } catch (error) {
        embeddedAgentLog.warn("Failed to persist an accepted native follow-up task", {
          error: formatErrorMessage(error),
        });
        if (custody.phase === "promoting") {
          custody.phase = previousPhase;
          this.scheduleReconciliation(state, custody);
        }
      }
    })();
    void this.track(state, consumed);
  }

  private async reconcile(state: ParentState, custody: SubmissionCustody): Promise<void> {
    if (!this.isObserving(state, custody)) {
      return;
    }
    try {
      const turn = await this.readTurn(state, custody);
      if (turn) {
        this.promote(state, custody, turn, true);
      }
    } catch (error) {
      embeddedAgentLog.warn("Failed to reconcile an accepted native follow-up receipt", {
        error: formatErrorMessage(error),
      });
    }
    this.scheduleReconciliation(state, custody);
  }

  private scheduleReconciliation(state: ParentState, custody: SubmissionCustody): void {
    if (!this.isObserving(state, custody) || !this.pollDelays.length) {
      return;
    }
    custody.timer = setTimeout(
      () => {
        custody.timer = undefined;
        void this.reconcile(state, custody);
      },
      delayForAttempt(this.pollDelays, custody.attempt++),
    );
    custody.timer.unref();
  }

  private readTurn(
    state: ParentState,
    custody: SubmissionCustody,
  ): Promise<JsonObject | undefined> {
    const childThreadId = custody.receipt.childThreadId;
    return readCodexNativeSubmissionTurn(custody.receipt, {
      client: this.dependencies.client,
      recovery: this.dependencies.recovery,
      prepareReceiver: () => this.dependencies.prepareReceiver(state, childThreadId),
      isCurrent: () => this.isObserving(state, custody),
      parentThreadId: () => this.nativeParentThreadId(state, childThreadId),
      currentChild: () => this.dependencies.currentChild(childThreadId),
    });
  }

  private finishCustody(state: ParentState, custody: SubmissionCustody): void {
    custody.phase = "settled";
    if (custody.timer) {
      clearTimeout(custody.timer);
    }
    const entries = this.pending.get(state);
    for (const [key, entry] of entries ?? []) {
      if (entry === custody) {
        entries!.delete(key);
      }
    }
    if (!entries?.size) {
      this.pending.delete(state);
    }
    custody.release();
    custody.completionCustody?.release();
    this.dependencies.onSettled(state);
  }

  private track(state: ParentState, operation: Promise<void>): Promise<void> {
    const writes = this.writes.get(state) ?? new Set<Promise<void>>();
    writes.add(operation);
    this.writes.set(state, writes);
    const remove = () => {
      writes.delete(operation);
      if (!writes.size) {
        this.writes.delete(state);
      }
      this.dependencies.onSettled(state);
    };
    void operation.then(remove, remove);
    return operation;
  }
}
