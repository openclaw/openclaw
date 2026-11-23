export const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";
export type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};
export type ModelSnapshotState = {
  lastSnapshot: ModelSnapshotEntry | null;
  latestSwitchTimestamp: number | null;
};

type ModelSnapshotSourceEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

/** Scan the already-selected active branch without cloning transcript-owned payloads. */
export function readModelSnapshotStateFromEntries(
  entries: readonly ModelSnapshotSourceEntry[],
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
