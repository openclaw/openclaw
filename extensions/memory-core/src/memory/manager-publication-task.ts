import type { MemoryShadowConnection, MemoryShadowFailure } from "./manager-shadow-task.js";
import type { MemorySourceIndexHeader } from "./manager-source-index-kernel.js";

export type MemoryPublicationConnection = MemoryShadowConnection;
export type MemoryPublicationState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
  extensionPath?: string;
};
export type MemoryPublicationFragment = { row: number; part: number; json: string; last: boolean };
export type MemoryPublicationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: MemoryShadowFailure; entered: boolean; committed: boolean };
export type MemoryPublicationOperations = {
  "stage.start": {
    input: { operation: string; header: MemorySourceIndexHeader; rows: number };
    output: void;
  };
  "stage.append": {
    input: { operation: string; fragments: MemoryPublicationFragment[] };
    output: void;
  };
  "stage.discard": { input: { operation: string }; output: void };
  "source.replace": {
    input: { operation: string; state: MemoryPublicationState };
    output: MemoryPublicationResult<{ beforeRevision: number; databaseRevision: number }>;
  };
  "source.delete": {
    input: {
      path: string;
      source: "memory" | "sessions";
      expectedHash: string | undefined;
      state: MemoryPublicationState;
    };
    output: MemoryPublicationResult<boolean>;
  };
  "database.publish": {
    input: {
      sourcePath: string;
      sourceIdentity: MemoryShadowConnection["fileIdentity"];
      metaKey: string;
      expectedRevision: number;
      sourceHasVectors: boolean;
      vectorIndexComplete: boolean;
      state: MemoryPublicationState;
    };
    output: MemoryPublicationResult<void>;
  };
};
