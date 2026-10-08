import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  codexNativeSubagentRunId,
  type NativeSubagentAssignment,
} from "./native-subagent-assignment.js";
import { readNativeTurnEnd } from "./native-subagent-history-recovery.js";
import type {
  ParentOwner,
  ParentState,
  ChildState,
  KnownChild,
  NativeSubagentMonitorClient,
} from "./native-subagent-monitor-types.js";
import {
  DEFAULT_RECOVERY_POLL_DELAYS_MS,
  logRecoveryFailure,
  type CodexNativeSubagentRecoveryCoordinator,
} from "./native-subagent-recovery-coordinator.js";
import { delayForAttempt } from "./native-subagent-retry.js";
import {
  createNativeSubagentSubmissionCalls,
  type NativeSubmissionCallDependencies,
  type NativeSubagentSubmissionCall as SubmissionCall,
} from "./native-subagent-submission-call.js";
import { readCodexNativeSubmissionTurn } from "./native-subagent-submission-history.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import { isJsonObject, type JsonObject, type CodexServerNotification } from "./protocol.js";

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
type SubmissionDependencies = NativeSubmissionCallDependencies & {
  isCurrent: (state: ParentState) => boolean;
  assertPersistenceCurrent: (state: ParentState) => void;
  client: NativeSubagentMonitorClient;
  recovery: CodexNativeSubagentRecoveryCoordinator;
  restoreKnownChild: (state: ParentState, assignment: NativeSubagentAssignment) => void;
  registerChild: (
    state: ParentState,
    assignment: NativeSubagentAssignment,
    options: { admitAssignment: true; completionCustody?: AgentHarnessCompletionCustody },
  ) => ChildState | undefined;
  admitFollowup: (known: KnownChild, threadId: string) => ChildState | undefined;
  resumeChild: (child: ChildState) => void;
  completeChild: (notification: CodexServerNotification, child: ChildState) => Promise<void>;
  retain: (state: ParentState, childThreadId: string) => () => void;
  recordPendingAssignment: (
    state: ParentState,
    receipt: CodexNativeSubagentSubmission,
    nativeParentThreadId: string,
  ) => void;
  onSettled: (state: ParentState) => void;
  recoveryPollDelaysMs?: readonly number[];
};

/** Captures successful native submissions before their turn notifications arrive. */
export class CodexNativeSubagentSubmissionOwner {
  private readonly calls = new Map<ParentState, Map<string, SubmissionCall>>();
  private readonly pending = new Map<ParentState, Map<string, SubmissionCustody>>();
  private readonly writes = new Map<ParentState, Set<Promise<void>>>();
  private readonly pollDelays: readonly number[];
  readonly modelInputs: ReturnType<typeof createNativeSubagentSubmissionCalls>;
  private disposed = false;

  constructor(private readonly dependencies: SubmissionDependencies) {
    this.pollDelays = dependencies.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
    this.modelInputs = createNativeSubagentSubmissionCalls(this.calls, dependencies, {
      isCurrent: (state) => this.isCurrent(state),
      capture: (state, receipt, owner, persist, completionCustody) =>
        this.capture(state, receipt, owner, persist, completionCustody),
      observeKnownChild: (threadId) => this.observeKnownChild(threadId),
    });
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
      this.modelInputs.settleSubmissionModelInput(call, false);
      return;
    }
    call.submissionId = submissionId;
    this.modelInputs.acceptNativeSubmission(state, call);
  }

  bind(state: ParentState, turnId: string): void {
    for (const call of this.calls.get(state)?.values() ?? []) {
      if (call.parentTurnId === turnId && call.submissionId) {
        this.modelInputs.acceptNativeSubmission(state, call);
      }
    }
  }

  restore(state: ParentState, owner: ParentOwner): void {
    try {
      for (const receipt of state.submissionStore?.read() ?? []) {
        this.capture(state, receipt, undefined, false, owner.completionCustody);
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
        this.modelInputs.hasSubmissionCallCustody(state, call),
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
          this.modelInputs.hasSubmissionCallCustody(state, call),
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
    this.modelInputs.pruneSubmissionCalls(state, calls);
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
      this.modelInputs.settleSubmissionModelInput(call, false);
      call.completionCustody?.release();
    }
    this.calls.delete(state);
    for (const custody of this.pending.get(state)?.values() ?? []) {
      custody.phase = "settled";
      clearTimeout(custody.timer);
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

  observeKnownChild(threadId: string, turn?: JsonObject): void {
    for (const [state, calls] of this.calls) {
      if (!this.isCurrent(state)) {
        continue;
      }
      for (const call of calls.values()) {
        this.modelInputs.observeSubmissionPredecessor(state, call, threadId, turn);
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
  ): void {
    if (this.disposed || !this.isCurrent(state)) {
      return;
    }
    const entries = this.pending.get(state) ?? new Map<string, SubmissionCustody>();
    const key = `${receipt.parentTurnId}\0${receipt.callId}\0${receipt.childThreadId}`;
    if (entries.has(key)) {
      return;
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
    if (persist) {
      this.dependencies.recordPendingAssignment(
        state,
        receipt,
        this.nativeParentThreadId(state, receipt.childThreadId),
      );
    }
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
    const observed = this.modelInputs.readObservedSubmissionTurn(
      state,
      receipt.childThreadId,
      receipt.submissionId,
    );
    if (observed) {
      this.promote(state, custody, observed);
    }
    if (custody.phase !== "promoting") {
      void this.reconcile(state, custody);
    }
  }

  private promote(
    state: ParentState,
    custody: SubmissionCustody,
    turn: JsonObject,
    historyValidated = false,
  ): void {
    if (
      !this.isObserving(state, custody) ||
      !this.admitTurn(
        state,
        custody.receipt,
        turn,
        custody.owner,
        historyValidated,
        custody.completionCustody,
      )
    ) {
      return;
    }
    custody.phase = "promoting";
    clearTimeout(custody.timer);
    // Native history owns execution. Keep its existing submission receipt until
    // the result is acknowledged; there is no task row to take restart custody.
  }

  settleChild(state: ParentState, child: ChildState): void {
    for (const custody of this.pending.get(state)?.values() ?? []) {
      if (
        custody.phase === "settled" ||
        codexNativeSubagentRunId(custody.receipt.childThreadId, custody.receipt.submissionId) !==
          child.runId
      ) {
        continue;
      }
      custody.phase = "settled";
      const settlement = (async () => {
        await custody.recorded;
        try {
          if (
            (child.nativeCompletionDelivered ||
              (child.subscriptionClosed && !child.pendingCompletion)) &&
            state.submissionStore
          ) {
            await state.submissionStore.consume(custody.receipt, () =>
              this.dependencies.assertPersistenceCurrent(state),
            );
          }
        } catch (error) {
          embeddedAgentLog.warn("Native follow-up receipt remains for reconciliation", {
            error: formatErrorMessage(error),
          });
        } finally {
          if ([...(this.pending.get(state)?.values() ?? [])].includes(custody)) {
            this.finishCustody(state, custody);
          }
        }
      })();
      void this.track(state, settlement);
    }
  }

  private async reconcile(state: ParentState, custody: SubmissionCustody): Promise<void> {
    if (!this.isObserving(state, custody)) {
      return;
    }
    try {
      const childThreadId = custody.receipt.childThreadId;
      const turn = await readCodexNativeSubmissionTurn(custody.receipt, {
        client: this.dependencies.client,
        recovery: this.dependencies.recovery,
        prepareReceiver: () => this.dependencies.prepareReceiver(state, childThreadId),
        isCurrent: () => this.isObserving(state, custody),
        parentThreadId: () => this.nativeParentThreadId(state, childThreadId),
        currentChild: () => this.dependencies.currentChild(childThreadId),
      });
      if (turn) {
        this.promote(state, custody, turn, true);
      }
    } catch (error) {
      embeddedAgentLog.warn("Failed to reconcile an accepted native follow-up receipt", {
        error: formatErrorMessage(error),
      });
    }
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

  private finishCustody(state: ParentState, custody: SubmissionCustody): void {
    custody.phase = "settled";
    clearTimeout(custody.timer);
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

  private admitTurn(
    state: ParentState,
    receipt: CodexNativeSubagentSubmission,
    turn: JsonObject,
    owner: ParentOwner | undefined,
    historyValidated: boolean,
    completionCustody: AgentHarnessCompletionCustody | undefined,
  ): boolean {
    if (
      readString(turn, "id") !== receipt.submissionId ||
      this.disposed ||
      !this.isCurrent(state)
    ) {
      return false;
    }
    const runId = codexNativeSubagentRunId(receipt.childThreadId, receipt.submissionId);
    let known = this.dependencies.knownChildren.get(receipt.childThreadId);
    if (!known) {
      if (!historyValidated) {
        return false;
      }
      this.dependencies.restoreKnownChild(state, {
        runId: receipt.predecessorRunId,
        childThreadId: receipt.childThreadId,
        nativeTurnId: receipt.predecessorNativeTurnId,
      });
      known = this.dependencies.knownChildren.get(receipt.childThreadId);
      if (known && known.assignment.runId === receipt.predecessorRunId) {
        known.assignment.terminal = true;
      }
    }
    if (known?.parent !== state) {
      return false;
    }
    if (
      known.assignment.runId !== receipt.predecessorRunId &&
      known.assignment.runId !== runId &&
      !known.pendingTurns.some((pending) => pending.turnId === receipt.submissionId)
    ) {
      return false;
    }
    if (
      known.assignment.runId === receipt.predecessorRunId &&
      known.assignment.nativeTurnId !== receipt.predecessorNativeTurnId
    ) {
      return false;
    }
    const status = readString(turn, "status");
    const nativeState = status === "inProgress" ? "active" : readNativeTurnEnd(turn);
    if (!nativeState) {
      return false;
    }
    if (known.assignment.runId === runId) {
      const child =
        this.dependencies.currentChild(receipt.childThreadId) ??
        this.dependencies.registerChild(
          state,
          { runId, childThreadId: receipt.childThreadId, nativeTurnId: receipt.submissionId },
          { admitAssignment: true, completionCustody },
        );
      if (!child) {
        return false;
      }
      child.nativeTurnState = nativeState;
      child.completionCustody ??= completionCustody?.retain();
    } else {
      let pending = known.pendingTurns.find(
        (candidate) => candidate.turnId === receipt.submissionId,
      );
      if (!pending) {
        pending = { turnId: receipt.submissionId, state: nativeState };
        known.pendingTurns.push(pending);
        known.observedTurns.set(receipt.submissionId, {});
      }
      pending.state = nativeState;
      pending.admittedSubmission = receipt;
      pending.completionCustody ??= completionCustody?.retain();
      if (owner && pending.admittedOwner !== owner && [...state.owners.values()].includes(owner)) {
        pending.admittedOwner = owner;
        owner.onDirectChildAccepted?.();
      }
      this.dependencies.admitFollowup(known, receipt.childThreadId);
    }
    const child = this.dependencies.currentChild(receipt.childThreadId);
    if (child?.runId !== runId) {
      return false;
    }
    if (nativeState === "active") {
      this.dependencies.resumeChild(child);
    } else if (Array.isArray(turn.items)) {
      void this.dependencies
        .completeChild(
          { method: "turn/completed", params: { threadId: receipt.childThreadId, turn } },
          child,
        )
        .catch((error: unknown) => logRecoveryFailure(receipt.childThreadId, error));
    }
    return true;
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
