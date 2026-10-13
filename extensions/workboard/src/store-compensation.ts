import type { WorkboardCard } from "@openclaw/workboard-contract";

function canonicalValue(value: object): string {
  // Compare persisted JSON facts with omitted undefined fields and stable key order.
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).toSorted(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
        )
      : entry,
  );
}

export function sameWorkboardCardState(left: WorkboardCard, right: WorkboardCard): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftState } = left;
  const { updatedAt: _rightUpdatedAt, ...rightState } = right;
  return canonicalValue(leftState) === canonicalValue(rightState);
}

export function sameWorkboardWorkspace(left: WorkboardCard, right: WorkboardCard): boolean {
  return (
    canonicalValue([
      left.metadata?.automation?.workspace,
      left.metadata?.automation?.workspaceAccess,
    ]) ===
    canonicalValue([
      right.metadata?.automation?.workspace,
      right.metadata?.automation?.workspaceAccess,
    ])
  );
}
