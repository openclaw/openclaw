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

export type MemoryEntryOriginBinding =
  | { kind: "origin" }
  | { kind: "forget"; prepareTombstones: boolean; extensionPath?: string };

export type MemoryForgetLineage = {
  agentId: string;
  sessionIds: readonly string[];
  entryKeys: readonly string[];
  identity: string;
};

export type MemoryForgetLineageResult =
  | { current: true }
  | { current: false; origins: MemoryEntryOrigin[] };

export function selectedMemoryLineageIdentity(
  origins: readonly MemoryEntryOrigin[],
  sessionIds: ReadonlySet<string>,
  entryKeys: ReadonlySet<string>,
): string {
  // Selected sessions and every contributor to their entries determine the purge.
  return JSON.stringify(
    origins
      .filter((origin) => sessionIds.has(origin.sessionId) || entryKeys.has(origin.entryKey))
      .map(({ entryKey, sessionId }) => [entryKey, sessionId]),
  );
}

export type MemoryEntryOriginOperations = {
  "forget.mark": { input: MemoryForgetLineage; output: MemoryForgetLineageResult };
  "forget.purge": {
    input: MemoryForgetLineage & {
      chunkIds: readonly string[];
      sources: readonly { path: string; source: string }[];
      hasVectorTable: boolean;
    };
    output: MemoryForgetLineageResult;
  };
  record: { input: MemoryOriginRecord; output: MemoryEntryOrigin[] };
  delete: { input: MemoryOriginDeletion; output: number };
};

export type MemorySessionTombstone = {
  sessionId: string;
  agentId: string;
  reason: string;
  createdAt: number;
};

export type MemoryOriginReadFilters = {
  entryKeys?: readonly string[];
  sessionIds?: readonly string[];
};

export type MemoryOriginReadInput = {
  agentId: string;
  databasePath: string;
  stateDir: string;
} & (
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
