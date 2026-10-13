import { isDeepStrictEqual } from "node:util";
import type { WorkboardCard } from "@openclaw/workboard-contract";

function canonicalValue(value: object): unknown {
  // Compare persisted JSON facts, including omitted optional fields.
  return JSON.parse(JSON.stringify(value));
}

export function sameWorkboardCardState(left: WorkboardCard, right: WorkboardCard): boolean {
  const { updatedAt: _leftUpdatedAt, ...leftState } = left;
  const { updatedAt: _rightUpdatedAt, ...rightState } = right;
  return isDeepStrictEqual(canonicalValue(leftState), canonicalValue(rightState));
}

export function sameWorkboardWorkspace(left: WorkboardCard, right: WorkboardCard): boolean {
  return isDeepStrictEqual(
    canonicalValue([
      left.metadata?.automation?.workspace,
      left.metadata?.automation?.workspaceAccess,
    ]),
    canonicalValue([
      right.metadata?.automation?.workspace,
      right.metadata?.automation?.workspaceAccess,
    ]),
  );
}
