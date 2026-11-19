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
