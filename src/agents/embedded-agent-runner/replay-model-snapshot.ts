import type { ModelSnapshotEntry, ModelSnapshotState } from "./replay-session-state.types.js";

export const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";

/** The native reader and SessionManager use the same snapshot history reducer. */
export function readModelSnapshotStateFromEntries(
  entries: Iterable<import("../sessions/session-manager-types.js").SessionEntry>,
): ModelSnapshotState {
  let lastSnapshot: ModelSnapshotEntry | null = null;
  let latestSwitchTimestamp: number | null = null;
  for (const entry of entries) {
    if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
      continue;
    }
    // SAFETY: replay history writes model-snapshot custom entries with this payload contract.
    const data = entry?.data as ModelSnapshotEntry | undefined;
    if (data && typeof data === "object") {
      if (
        lastSnapshot &&
        !isSameModelSnapshot(lastSnapshot, data) &&
        Number.isFinite(data.timestamp)
      ) {
        latestSwitchTimestamp = data.timestamp;
      }
      lastSnapshot = data;
    }
  }
  return { lastSnapshot, latestSwitchTimestamp };
}

export function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  return (["provider", "modelApi", "modelId"] as const).every(
    (field) => (a[field] ?? "") === (b[field] ?? ""),
  );
}
