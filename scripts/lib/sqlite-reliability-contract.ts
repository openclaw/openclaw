export type ProfileId = "smoke" | "default" | "large";

export type ProfileConfig = {
  iterations: number;
  payloadBytes: number;
  retainedBatches: number;
  rowsPerBatch: number;
  writerPauseMs: number;
};

export type CliOptions = {
  agentId: string | null;
  output: string | null;
  profile: ProfileId;
  repository: string | null;
  stateDir: string | null;
};

export type ReliabilityReport = {
  arch: string;
  iterations: number;
  node: string;
  paths: {
    repository: string;
    sourceDatabase: string;
    stateDir: string;
    syncedRepository: string;
  };
  platform: NodeJS.Platform;
  profile: ProfileId;
  retainedBatches: number;
  restoresVerified: number;
  rowsPerBatch: number;
  snapshotBytes: {
    max: number;
    min: number;
  };
  target: string;
  timingsMs: {
    restoreP50: number;
    restoreP95: number;
    snapshotP50: number;
    snapshotP95: number;
    total: number;
  };
  transactionProof: {
    committedWalSentinel: true;
    heldBatch: number;
    heldRows: number;
    visibleAfterRestore: false;
  };
  walBytes: {
    after: number;
    before: number;
  };
  writer: {
    batchesCommitted: number;
    rowsCommitted: number;
  };
};

export const PROFILES: Record<ProfileId, ProfileConfig> = {
  smoke: {
    iterations: 4,
    payloadBytes: 512,
    retainedBatches: 32,
    rowsPerBatch: 8,
    writerPauseMs: 5,
  },
  default: {
    iterations: 25,
    payloadBytes: 4 * 1024,
    retainedBatches: 128,
    rowsPerBatch: 32,
    writerPauseMs: 5,
  },
  large: {
    iterations: 100,
    payloadBytes: 8 * 1024,
    retainedBatches: 256,
    rowsPerBatch: 64,
    writerPauseMs: 1,
  },
};

export const STRESS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS openclaw_reliability_sentinel (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS openclaw_reliability_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE(batch, ordinal)
  );
`;

export const COMMITTED_WAL_SENTINEL = "committed-before-ready";
