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
