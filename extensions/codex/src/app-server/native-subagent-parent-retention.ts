import type { ChildState, ParentState } from "./native-subagent-monitor-types.js";

type SettledNativeParentRetention = {
  parentThreadId: string;
  children: ReadonlyMap<string, ChildState>;
  parents: ReadonlyMap<string, ParentState>;
  retentions: Map<string, () => void>;
  /** Held completions resume once the retention that blocked them is gone. */
  resumeDetached: (state: ParentState) => void;
};

/**
 * Native child work pins its parent thread until every sibling settles. A pinned
 * parent refuses the release a completion announce needs, so an unsettled child
 * both keeps the parent subscription alive and blocks its siblings' delivery.
 */
export function hasUnsettledNativeChild(
  children: ReadonlyMap<string, ChildState>,
  parentThreadId: string,
  exclude?: ChildState,
): boolean {
  for (const childState of children.values()) {
    if (
      childState !== exclude &&
      childState.parentThreadId === parentThreadId &&
      !childState.terminal &&
      !childState.settledWithoutCompletion
    ) {
      return true;
    }
  }
  return false;
}

/** True while a running sibling keeps this parent thread pinned against an announce. */
export function holdsNativeParentThreadForSibling(
  retentions: ReadonlyMap<string, () => void>,
  children: ReadonlyMap<string, ChildState>,
  state: ParentState,
  child: ChildState,
): boolean {
  return (
    retentions.has(state.parentThreadId) &&
    hasUnsettledNativeChild(children, state.parentThreadId, child)
  );
}

/** Drop a settled parent's retention, then resume the completions it held. */
export function releaseSettledNativeParentThread(retention: SettledNativeParentRetention): void {
  const { parentThreadId, children, parents, retentions } = retention;
  if (hasUnsettledNativeChild(children, parentThreadId)) {
    return;
  }
  // Pending completion delivery keeps its own custody, but must not block
  // the parent from resuming to receive those results.
  const releaseParentThread = retentions.get(parentThreadId);
  retentions.delete(parentThreadId);
  releaseParentThread?.();
  if (!releaseParentThread) {
    return;
  }
  const state = parents.get(parentThreadId);
  if (state) {
    retention.resumeDetached(state);
  }
}
