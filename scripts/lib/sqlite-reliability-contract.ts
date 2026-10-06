import type { runReliabilityStress } from "./sqlite-reliability-runner.js";

type ProfileId = "smoke" | "default" | "large";

export type IndexRepairJournalMode = "delete" | "wal";

export const INDEX_REPAIR_INDEX_NAME = "idx_openclaw_reliability_records_identity";
export const INDEX_REPAIR_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS openclaw_reliability_index_records (
    id INTEGER PRIMARY KEY,
    identity TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_REPAIR_INDEX_NAME}
    ON openclaw_reliability_index_records(identity);
`;

export type ProfileConfig = {
  iterations: number;
  maxWalBytes: number;
  payloadBytes: number;
  retainedBatches: number;
  rowsPerBatch: number;
  walAutoCheckpointPages: number;
  writerPauseMs: number;
};

export type CliOptions = {
  agentId: string | null;
  output: string | null;
  profile: ProfileId;
  repository: string | null;
  stateDir: string | null;
};

export type CompactionPayloadProof = {
  bytes: number;
  idSum: number;
  rows: number;
};

export type ReliabilityStateProof = {
  batches: number;
  rows: number;
  sha256: string;
};

export function assertSameReliabilityState(
  actual: ReliabilityStateProof,
  expected: ReliabilityStateProof,
  label: string,
): void {
  if (
    actual.batches !== expected.batches ||
    actual.rows !== expected.rows ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      `${label} changed reliability state: expected batches=${expected.batches} rows=${expected.rows} sha256=${expected.sha256}, got batches=${actual.batches} rows=${actual.rows} sha256=${actual.sha256}`,
    );
  }
}

export function formatReliabilityStderr(stderr: string): string {
  const text = stderr.trim();
  return text ? ` stderr=${JSON.stringify(text)}` : "";
}

export function assertSameCompactionPayload(
  actual: CompactionPayloadProof,
  expected: CompactionPayloadProof,
  label: string,
): void {
  if (
    actual.bytes !== expected.bytes ||
    actual.idSum !== expected.idSum ||
    actual.rows !== expected.rows
  ) {
    throw new Error(
      `${label} changed compaction payload: expected rows=${expected.rows} bytes=${expected.bytes} idSum=${expected.idSum}, got rows=${actual.rows} bytes=${actual.bytes} idSum=${actual.idSum}`,
    );
  }
}

export type ReliabilityReport = Awaited<ReturnType<typeof runReliabilityStress>>;

export const PROFILES: Record<ProfileId, ProfileConfig> = {
  smoke: {
    // One snapshot before the forced writer crash and one after restart prove
    // both distinct smoke paths; larger profiles retain repeated stress loops.
    iterations: 2,
    maxWalBytes: 64 * 1024 * 1024,
    payloadBytes: 512,
    retainedBatches: 32,
    rowsPerBatch: 8,
    walAutoCheckpointPages: 256,
    writerPauseMs: 5,
  },
  default: {
    iterations: 25,
    maxWalBytes: 512 * 1024 * 1024,
    payloadBytes: 4 * 1024,
    retainedBatches: 128,
    rowsPerBatch: 32,
    walAutoCheckpointPages: 4 * 1024,
    writerPauseMs: 5,
  },
  large: {
    iterations: 100,
    maxWalBytes: 8 * 1024 * 1024 * 1024,
    payloadBytes: 8 * 1024,
    retainedBatches: 256,
    rowsPerBatch: 64,
    walAutoCheckpointPages: 16 * 1024,
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
