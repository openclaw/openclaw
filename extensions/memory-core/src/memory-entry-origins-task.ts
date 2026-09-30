import type { MemoryEntryOrigin } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemoryOriginRecord = {
  agentId: string;
  origins: readonly MemoryEntryOrigin[];
  entryKey?: string;
};

export type MemoryOriginDeletion = {
  agentId: string;
  entryKeys: readonly string[];
  sessionIds?: readonly string[];
};

export type MemoryEntryOriginOperations = {
  record: { input: MemoryOriginRecord; output: MemoryEntryOrigin[] };
  delete: { input: MemoryOriginDeletion; output: number };
};

export type MemorySessionTombstone = {
  sessionId: string;
  agentId: string;
  reason: string;
  createdAt: number;
};

export type MemoryOriginReadTarget = {
  agentId: string;
  databasePath: string;
  stateDir: string;
};

export type MemoryOriginReadFilters = {
  entryKeys?: readonly string[];
  sessionIds?: readonly string[];
};

export type MemoryOriginReadInput = MemoryOriginReadTarget &
  (
    | ({ kind: "origin-rows" } & MemoryOriginReadFilters)
    | ({ kind: "origin-exists"; entryKeys: readonly string[] } & MemoryOriginReadFilters)
    | { kind: "session-tombstones"; sessionIds?: readonly string[] }
    | { kind: "origin-index-keys" }
  );

export type MemoryOriginReadOutput =
  | { kind: "origin-rows"; rows: MemoryEntryOrigin[] }
  | { kind: "origin-exists"; exists: boolean }
  | { kind: "session-tombstones"; rows: MemorySessionTombstone[] }
  | { kind: "origin-index-keys"; keys: string[] };
