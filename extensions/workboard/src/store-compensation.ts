import { isDeepStrictEqual } from "node:util";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
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
