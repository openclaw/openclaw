import type { AgentHarnessCompletionCustody } from "openclaw/plugin-sdk/agent-harness-completion";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readNativeTurnEnd } from "./native-subagent-history-recovery.js";
import { assertNativeModelInputCompatible } from "./native-subagent-model-input.js";
import {
  MAX_PENDING_CHILD_ADMISSION_EVIDENCE,
  retainNativeModelSource,
} from "./native-subagent-model-source.js";
import type {
  ChildState,
  KnownChild,
  NativeModelSourceCustody,
  NativeModelInputRequest,
  NativeModelSourceRequest,
  ParentOwner,
  ParentState,
} from "./native-subagent-monitor-types.js";
import type { CodexNativeSubagentSubmission } from "./native-subagent-submission.js";
import type { JsonObject } from "./protocol.js";

type Predecessor =
  | { runId: string; nativeTurnId: string; terminal: boolean }
  | { child: ChildState };

export type NativeSubagentSubmissionCall = {
  parentTurnId: string;
  callId: string;
  targets: Array<{ childThreadId: string; predecessor: Predecessor }>;
  owner?: ParentOwner;
  submissionId?: string;
  closed?: true;
  accepted?: true;
  modelInput?: {
    threadId: string;
    source: NativeModelSourceCustody;
  };
  completionCustody?: AgentHarnessCompletionCustody;
};

export type NativeSubmissionCallDependencies = {
  parentOwner: (state: ParentState, turnId: string) => ParentOwner | undefined;
  knownChildren: ReadonlyMap<string, KnownChild>;
  currentChild: (threadId: string) => ChildState | undefined;
  currentModelExecution: (threadId: string) => ParentOwner | undefined;
  prepareReceiver: (state: ParentState, threadId: string) => boolean;
};
type SubmissionCalls = Map<ParentState, Map<string, NativeSubagentSubmissionCall>>;

export function admitSubmissionModelInput(params: {
  state: ParentState;
  owner: ParentOwner;
  request: NativeModelInputRequest;
  pendingModelSources: number;
  preparedOwner?: ParentOwner;
  calls: SubmissionCalls;
  dependencies: NativeSubmissionCallDependencies;
  isCurrent: () => boolean;
}): void {
  const { state, owner, request, calls, dependencies, isCurrent } = params;
  if (!owner.modelSource || !isCurrent()) {
    throw new Error("Codex native input has no admitted model source");
  }
  const receiver = dependencies.currentModelExecution(request.targetThreadId);
  assertNativeModelInputCompatible(owner, receiver ?? owner);
  for (const entries of calls.values()) {
    for (const pending of entries.values()) {
      if (pending.modelInput?.threadId === request.targetThreadId) {
        assertNativeModelInputCompatible(owner, pending.modelInput.source.owner);
      }
    }
  }
  const key = `${request.turnId}\0${request.itemId}`;
  if (owner.modelSource.hasOperatorSource && !calls.get(state)?.has(key)) {
    const reservations = [...calls.values()].reduce(
      (count, entries) =>
        count +
        [...entries.values()].filter(
          (call) => call.modelInput?.source.owner.modelSource?.hasOperatorSource,
        ).length,
      0,
    );
    if (reservations + params.pendingModelSources >= MAX_PENDING_CHILD_ADMISSION_EVIDENCE) {
      throw new Error("Codex pending native input admission capacity reached");
    }
  }
  observeSubmissionCall(
    state,
    request.turnId,
    {
      id: request.itemId,
      receiverThreadIds: [request.targetThreadId],
    },
    calls,
    dependencies,
    isCurrent,
  );
  const call = calls.get(state)?.get(key);
  if (
    !call ||
    call.closed ||
    call.owner !== owner ||
    call.modelInput?.threadId !== request.targetThreadId
  ) {
    throw new Error("Codex native input reused an unsettled call identity");
  }
  if (params.preparedOwner && call.modelInput.source.owner === owner) {
    const prepared = retainNativeModelSource(params.preparedOwner);
    if (!prepared) {
      throw new Error("Codex native input lost its prepared model source");
    }
    call.modelInput.source.release();
    call.modelInput.source = prepared;
  }
}

export function hasPendingSubmissionModelInput(
  calls: SubmissionCalls,
  request: NativeModelSourceRequest,
): boolean {
  for (const entries of calls.values()) {
    for (const call of entries.values()) {
      if (
        !call.closed &&
        call.modelInput?.threadId === request.threadId &&
        (call.parentTurnId === request.parentTurnId || call.parentTurnId === request.rootTurnId)
      ) {
        const capture = call.modelInput.source.owner.modelSource?.capture();
        capture?.release();
        return Boolean(capture);
      }
    }
  }
  return false;
}

export function retireReceiverModelInputs(
  calls: SubmissionCalls,
  threadId: string,
  dependencies: NativeSubmissionCallDependencies,
): void {
  for (const entries of calls.values()) {
    for (const call of entries.values()) {
      if (call.modelInput?.threadId === threadId) {
        settleSubmissionModelInput(call, false, dependencies);
        call.closed = true;
      }
    }
  }
}

export function readObservedSubmissionTurn(
  state: ParentState,
  threadId: string,
  turnId: string,
  dependencies: NativeSubmissionCallDependencies,
): JsonObject | undefined {
  const known = dependencies.knownChildren.get(threadId);
  if (known?.parent !== state) {
    return undefined;
  }
  const pending = known.pendingTurns.find((turn) => turn.turnId === turnId);
  const child = dependencies.currentChild(threadId);
  const status =
    pending?.state ?? (child?.nativeTurnId === turnId ? child.nativeTurnState : undefined);
  return status ? { id: turnId, status: status === "active" ? "inProgress" : status } : undefined;
}

export function observeSubmissionCall(
  state: ParentState,
  turnId: string | undefined,
  item: JsonObject,
  allCalls: Map<ParentState, Map<string, NativeSubagentSubmissionCall>>,
  dependencies: NativeSubmissionCallDependencies,
  isCurrent: () => boolean,
): void {
  const callId = readString(item, "id");
  if (!turnId || !callId || !isCurrent()) {
    return;
  }
  const owner = dependencies.parentOwner(state, turnId);
  if (!owner && ![...state.owners.values()].some((candidate) => !candidate.turnId)) {
    return;
  }
  const calls = allCalls.get(state) ?? new Map<string, NativeSubagentSubmissionCall>();
  const key = `${turnId}\0${callId}`;
  if (calls.has(key) || (!owner && calls.size >= 32)) {
    return;
  }
  const receivers = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
  const targets = receivers.flatMap((id) => {
    if (typeof id !== "string") {
      return [];
    }
    dependencies.prepareReceiver(state, id);
    const predecessor = captureSubmissionPredecessor({
      state,
      known: dependencies.knownChildren.get(id),
      child: dependencies.currentChild(id),
    });
    return predecessor ? [{ childThreadId: id, predecessor }] : [];
  });
  const receiver = receivers.length === 1 ? receivers[0] : undefined;
  const source = typeof receiver === "string" ? retainNativeModelSource(owner) : undefined;
  if (!targets.length && !source) {
    return;
  }
  calls.set(key, {
    parentTurnId: turnId,
    callId,
    targets,
    owner,
    ...(source && typeof receiver === "string"
      ? { modelInput: { threadId: receiver, source } }
      : {}),
  });
  allCalls.set(state, calls);
}

export function assertSubmissionModelInputsCurrent(
  calls: Iterable<ReadonlyMap<string, NativeSubagentSubmissionCall>>,
  threadId: string,
  owner: ParentOwner,
): void {
  for (const pending of calls) {
    for (const call of pending.values()) {
      if (call.modelInput?.threadId === threadId) {
        try {
          assertNativeModelInputCompatible(call.modelInput.source.owner, owner);
        } catch (error) {
          if (call.accepted) {
            owner.modelExecutionCancelled = true;
          }
          throw error;
        }
      }
    }
  }
}

export function settleSubmissionModelInput(
  call: NativeSubagentSubmissionCall,
  accepted: boolean,
  dependencies: Pick<NativeSubmissionCallDependencies, "knownChildren" | "currentModelExecution">,
): void {
  const input = call.modelInput;
  if (!input) {
    return;
  }
  // An ambiguous accepted receiver keeps the pending dispatch fence until its
  // exact execution is known; cleanup itself never needs to select a receiver.
  const receiver = accepted ? dependencies.currentModelExecution(input.threadId) : undefined;
  call.modelInput = undefined;
  try {
    const known = dependencies.knownChildren.get(input.threadId);
    const isOtherTurn =
      call.submissionId &&
      known?.observedTurns.has(call.submissionId) &&
      receiver?.turnId !== call.submissionId;
    if (accepted && receiver && !isOtherTurn) {
      try {
        assertNativeModelInputCompatible(input.source.owner, receiver);
      } catch {
        // V1's opaque receipt is not a new turn ID when it steers. Do not
        // reassign that execution; its mixed input cannot dispatch again.
        receiver.modelExecutionCancelled = true;
      }
    }
  } finally {
    input.source.release();
  }
}

export function hasSubmissionCallCustody(
  state: ParentState,
  call: NativeSubagentSubmissionCall,
  hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean,
): boolean {
  return Boolean(
    call.accepted &&
    call.targets.some(
      ({ childThreadId }) =>
        state.owners.size > 0 || hasObservationBacking?.(state.parentThreadId, childThreadId),
    ),
  );
}

function captureSubmissionPredecessor(params: {
  state: ParentState;
  known: KnownChild | undefined;
  child: ChildState | undefined;
}): Predecessor | undefined {
  const { state, known, child } = params;
  if (known?.parent !== state) {
    return undefined;
  }
  if (!known.assignment.nativeTurnId) {
    // A fresh observed child can supply its own delayed anchor; a restored
    // anchorless row cannot select a predecessor from later history.
    return child &&
      child.runId === known.assignment.runId &&
      !child.terminal &&
      !known.assignment.terminal &&
      !known.assignment.unanchored
      ? { child }
      : undefined;
  }
  return {
    runId: known.assignment.runId,
    nativeTurnId: known.assignment.nativeTurnId,
    terminal:
      known.assignment.terminal ||
      child?.nativeTurnState === "completed" ||
      child?.nativeTurnState === "failed",
  };
}

export function observeSubmissionPredecessor(params: {
  state: ParentState;
  call: NativeSubagentSubmissionCall;
  threadId: string;
  turn?: JsonObject;
  known: KnownChild | undefined;
  hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean;
  acceptContinuation: (owner: ParentOwner) => void;
  capture: (receipt: CodexNativeSubagentSubmission, owner: ParentOwner | undefined) => void;
}): void {
  const { state, call, threadId, turn, known } = params;
  const submissionId = call.submissionId;
  if (!call.accepted || !submissionId) {
    return;
  }
  call.targets = call.targets.filter(({ childThreadId, predecessor }) => {
    if (childThreadId !== threadId || !("child" in predecessor)) {
      return true;
    }
    const child = predecessor.child;
    if (
      known?.parent !== state ||
      known.assignment.runId !== child.runId ||
      (state.owners.size === 0 && !params.hasObservationBacking?.(state.parentThreadId, threadId))
    ) {
      return false;
    }
    const nativeTurnId = child.nativeTurnId;
    if (
      !nativeTurnId ||
      nativeTurnId === submissionId ||
      known.assignment.nativeTurnId !== nativeTurnId
    ) {
      return true;
    }
    const ended = readString(turn, "id") === nativeTurnId ? readNativeTurnEnd(turn) : undefined;
    const nativeState = ended ?? child.nativeTurnState;
    const owner =
      call.owner && [...state.owners.values()].includes(call.owner) ? call.owner : undefined;
    if (nativeState === "interrupted") {
      if (owner) {
        params.acceptContinuation(owner);
      }
      return false;
    }
    if (!known.assignment.terminal && nativeState !== "completed" && nativeState !== "failed") {
      return true;
    }
    params.capture(
      {
        parentTurnId: call.parentTurnId,
        callId: call.callId,
        childThreadId,
        submissionId,
        predecessorRunId: child.runId,
        predecessorNativeTurnId: nativeTurnId,
      },
      owner,
    );
    return false;
  });
  if (call.targets.length === 0) {
    call.owner = undefined;
    call.completionCustody?.release();
    call.completionCustody = undefined;
  }
}

export function pruneSubmissionCalls(
  state: ParentState,
  calls: Map<string, NativeSubagentSubmissionCall> | undefined,
  dependencies: {
    parentOwner: (state: ParentState, turnId: string) => ParentOwner | undefined;
    hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean;
  } & Pick<NativeSubmissionCallDependencies, "knownChildren" | "currentModelExecution">,
): void {
  const hasUnboundOwner = [...state.owners.values()].some((owner) => !owner.turnId);
  for (const [key, call] of calls ?? []) {
    if (hasSubmissionCallCustody(state, call, dependencies.hasObservationBacking)) {
      if (!call.owner || ![...state.owners.values()].includes(call.owner)) {
        call.owner = undefined;
      }
      continue;
    }
    if (
      (call.owner && ![...state.owners.values()].includes(call.owner)) ||
      (!dependencies.parentOwner(state, call.parentTurnId) && !hasUnboundOwner)
    ) {
      settleSubmissionModelInput(call, false, dependencies);
      calls!.delete(key);
      call.completionCustody?.release();
    }
  }
}

export function acceptSubmissionModelInteraction(
  calls: ReadonlyMap<string, NativeSubagentSubmissionCall> | undefined,
  turnId: string | undefined,
  itemId: string | undefined,
  threadId: string,
  accept: (owner: ParentOwner) => void,
  dependencies: NativeSubmissionCallDependencies,
): boolean {
  const call = calls?.get(`${turnId ?? ""}\0${itemId ?? ""}`);
  if (!call) {
    return false;
  }
  if (call.closed || !call.modelInput) {
    return true;
  }
  if (call.modelInput.threadId !== threadId) {
    throw new Error("Codex native interaction changed its admitted target");
  }
  call.accepted = true;
  accept(call.modelInput.source.owner);
  call.closed = true;
  settleSubmissionModelInput(call, true, dependencies);
  return true;
}

export function acceptNativeSubmission(
  state: ParentState,
  call: NativeSubagentSubmissionCall,
  dependencies: NativeSubmissionCallDependencies & {
    isCurrent: (state: ParentState) => boolean;
    acceptContinuation: (
      state: ParentState,
      owner: ParentOwner,
      childThreadId: string,
      call: NativeSubagentSubmissionCall,
      modelOwner?: ParentOwner,
    ) => void;
    capture: (
      state: ParentState,
      receipt: CodexNativeSubagentSubmission,
      owner: ParentOwner | undefined,
      persist: boolean,
    ) => void;
    observeKnownChild: (threadId: string) => void;
  },
): void {
  const owner = dependencies.parentOwner(state, call.parentTurnId);
  if (
    call.closed ||
    !owner ||
    (call.owner && owner !== call.owner) ||
    !call.submissionId ||
    !dependencies.isCurrent(state)
  ) {
    return;
  }
  call.closed = true;
  call.accepted = true;
  call.owner = owner;
  call.completionCustody ??= owner.completionCustody?.retain();
  const modelSource = retainNativeModelSource(call.modelInput?.source.owner);
  try {
    settleSubmissionModelInput(call, true, dependencies);
    const targets = call.targets;
    call.targets = [];
    for (const target of targets) {
      const { childThreadId, predecessor } = target;
      const modelOwner = modelSource?.owner ?? owner;
      if (modelOwner.modelSource && ("child" in predecessor || predecessor.terminal)) {
        dependencies.acceptContinuation(
          state,
          {
            ...owner,
            claimDirectChild: undefined,
            rejectPendingDirectChild: undefined,
            onDirectChildAccepted: undefined,
          },
          childThreadId,
          call,
          modelOwner,
        );
      }
      if ("child" in predecessor) {
        call.targets.push(target);
        continue;
      }
      if (!predecessor.terminal) {
        dependencies.acceptContinuation(state, owner, childThreadId, call, modelOwner);
        continue;
      }
      dependencies.capture(
        state,
        {
          parentTurnId: call.parentTurnId,
          callId: call.callId,
          childThreadId,
          submissionId: call.submissionId,
          predecessorRunId: predecessor.runId,
          predecessorNativeTurnId: predecessor.nativeTurnId,
        },
        owner,
        true,
      );
    }
    for (const { childThreadId } of call.targets) {
      dependencies.observeKnownChild(childThreadId);
    }
    if (!call.targets.length) {
      call.completionCustody?.release();
      call.completionCustody = undefined;
    }
  } finally {
    modelSource?.release();
  }
}
