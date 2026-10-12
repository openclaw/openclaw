import type { KnownChild, ParentState } from "./native-subagent-monitor-types.js";
import { matchesNativeAssignmentLifecycle } from "./native-subagent-pending-assignments.js";

type ReceiverDependencies = {
  isCurrent: (state: ParentState) => boolean;
  isRetired: (state: ParentState) => boolean;
  hasChildCustody: (state: ParentState, threadId: string) => boolean;
};

/** Read-only eligibility; transferring observation still needs fresh native lineage. */
export function canPrepareNativeReceiver(
  state: ParentState,
  previous: ParentState | undefined,
  child: KnownChild | undefined,
  threadId: string,
  dependencies: ReceiverDependencies,
): boolean {
  if (previous === state) {
    return true;
  }
  if (
    !dependencies.isCurrent(state) ||
    (child &&
      (!child.assignment.terminal ||
        child.pendingTurns.length > 0 ||
        dependencies.hasChildCustody(child.parent, threadId)))
  ) {
    return false;
  }
  if (!previous) {
    return true;
  }
  if (
    dependencies.isRetired(previous) ||
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
    return true;
  } catch {
    return false;
  }
}
