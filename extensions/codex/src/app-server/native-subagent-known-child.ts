import { releaseCompletionCustody } from "./native-subagent-admission-custody.js";
import type { NativeSubagentAssignment } from "./native-subagent-assignment.js";
import type {
  ChildState,
  KnownChild,
  NativeTurnObservation,
  ParentState,
} from "./native-subagent-monitor-types.js";

/** Restore observations into the monitor's existing assignment and custody owners. */
export function restoreKnownNativeChild(
  state: ParentState,
  assignment: NativeSubagentAssignment,
  observedTurns: readonly NativeTurnObservation[],
  dependencies: {
    knownChildren: Map<string, KnownChild>;
    childStates: ReadonlyMap<string, ChildState>;
    resolveChildReceiptOwner: (
      state: ParentState,
      threadId: string,
    ) => KnownChild["deliveryReceipts"];
    refreshWaitDependency: (state: ParentState, threadId: string) => void;
  },
): void {
  const currentIndex = observedTurns.findIndex((turn) => turn.turnId === assignment.nativeTurnId);
  const pendingTurns: KnownChild["pendingTurns"] = observedTurns
    .filter((turn, index) => index > currentIndex && turn.turnId !== assignment.nativeTurnId)
    .map((turn, index, turns) => ({
      turnId: turn.turnId,
      state: turn.state === "active" && index < turns.length - 1 ? undefined : turn.state,
    }));
  const previous = dependencies.knownChildren.get(assignment.childThreadId);
  const previousRunId = previous?.assignment.runId;
  const retainedPending = previous?.pendingTurns.filter((pending) => pending.modelSource) ?? [];
  for (const retained of retainedPending) {
    const recovered = pendingTurns.find((pending) => pending.turnId === retained.turnId);
    if (recovered) {
      recovered.modelSource = retained.modelSource;
      recovered.completionCustody = retained.completionCustody;
      retained.completionCustody = undefined;
    } else {
      pendingTurns.push(retained);
    }
  }
  for (const pending of previous?.pendingTurns ?? []) {
    if (!pendingTurns.includes(pending)) {
      releaseCompletionCustody(pending);
    }
  }
  dependencies.knownChildren.set(assignment.childThreadId, {
    configurationQualification: previous?.configurationQualification,
    parent: state,
    nativeParentThreadId:
      dependencies.childStates.get(assignment.runId)?.nativeParentThreadId ?? state.parentThreadId,
    deliveryReceipts: dependencies.resolveChildReceiptOwner(state, assignment.childThreadId),
    assignment: {
      ...assignment,
      terminal: false,
    },
    turnId: pendingTurns.at(-1)?.turnId ?? assignment.nativeTurnId,
    observedTurns: new Map(
      [
        ...new Set(
          [assignment.nativeTurnId, ...observedTurns.map((turn) => turn.turnId)].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ].map((turnId) => [
        turnId,
        {
          ...(pendingTurns.some((turn) => turn.turnId === turnId)
            ? { awaitingInteraction: true as const }
            : {}),
          state: observedTurns.find((turn) => turn.turnId === turnId)?.state,
        },
      ]),
    ),
    pendingTurns,
    agentPaths:
      dependencies.knownChildren.get(assignment.childThreadId)?.agentPaths ??
      new Set([assignment.childThreadId]),
  });
  if (previousRunId !== assignment.runId) {
    dependencies.refreshWaitDependency(state, assignment.childThreadId);
  }
}
