import { releaseCompletionCustody } from "./native-subagent-admission-custody.js";
import type { NativeSubagentAssignment } from "./native-subagent-assignment.js";
import type { CodexNativeSubagentDeliveryReceipts } from "./native-subagent-delivery-receipts.js";
import type { RetiredNativeChildPaths } from "./native-subagent-model-input.js";
import type {
  ChildState,
  KnownChild,
  NativeTurnObservation,
  ParentState,
} from "./native-subagent-monitor-types.js";

/** Rebuilds one validated child assignment without losing its retained receipt paths or custody. */
export function restoreNativeKnownChild(params: {
  state: ParentState;
  assignment: NativeSubagentAssignment;
  observedTurns: readonly NativeTurnObservation[];
  knownChildren: Map<string, KnownChild>;
  children: ReadonlyMap<string, ChildState>;
  receiptOwner: CodexNativeSubagentDeliveryReceipts;
  retiredChildren: RetiredNativeChildPaths;
  registerAgentPath: (path: string) => void;
  refreshWaitDependency: () => void;
}): void {
  const {
    state,
    assignment,
    observedTurns,
    knownChildren,
    children,
    receiptOwner,
    retiredChildren,
    registerAgentPath,
    refreshWaitDependency,
  } = params;
  const currentIndex = observedTurns.findIndex((turn) => turn.turnId === assignment.nativeTurnId);
  const pendingTurns: KnownChild["pendingTurns"] = observedTurns
    .filter((turn, index) => index > currentIndex && turn.turnId !== assignment.nativeTurnId)
    .map((turn, index, turns) => ({
      turnId: turn.turnId,
      state: turn.state === "active" && index < turns.length - 1 ? undefined : turn.state,
    }));
  const previous = knownChildren.get(assignment.childThreadId);
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
  knownChildren.set(assignment.childThreadId, {
    configurationQualification: previous?.configurationQualification,
    parent: state,
    nativeParentThreadId:
      children.get(assignment.runId)?.nativeParentThreadId ?? state.parentThreadId,
    deliveryReceipts: receiptOwner,
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
      knownChildren.get(assignment.childThreadId)?.agentPaths ??
      new Set([assignment.childThreadId]),
  });
  // Validated reconstruction can reuse paths that this native parent already
  // observed. The normal registration owner still rejects live alias conflicts.
  const restored = knownChildren.get(assignment.childThreadId)!;
  for (const path of retiredChildren.agentPaths(
    restored.nativeParentThreadId,
    assignment.childThreadId,
  )) {
    registerAgentPath(path);
  }
  if (previousRunId !== assignment.runId) {
    refreshWaitDependency();
  }
}
