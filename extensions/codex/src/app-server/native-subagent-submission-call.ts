import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readNativeTurnEnd } from "./native-subagent-history-recovery.js";
import type {
  ChildState,
  KnownChild,
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
};

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

export function captureSubmissionPredecessor(params: {
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
  }
}
