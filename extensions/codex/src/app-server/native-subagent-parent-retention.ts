import type { ChildState } from "./native-subagent-monitor-types.js";

/** Pending delivery keeps custody, but does not retain execution protection. */
export function releaseSettledNativeParent(
  children: Iterable<ChildState>,
  retained: Map<string, () => void>,
  parentThreadId: string,
): void {
  for (const child of children) {
    if (
      child.parentThreadId === parentThreadId &&
      !child.terminal &&
      !child.settledWithoutCompletion
    ) {
      return;
    }
  }
  const release = retained.get(parentThreadId);
  retained.delete(parentThreadId);
  release?.();
}
