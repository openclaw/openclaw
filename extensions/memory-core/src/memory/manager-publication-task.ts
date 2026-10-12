import type { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import type { loadMemoryEmbeddingCache } from "./manager-embedding-cache.js";
import type { MemoryIndexMeta, MemoryIndexProviderIdentity } from "./manager-reindex-state.js";
import type { MemoryDatabaseFacts } from "./manager-retrieval-read.js";
import type { MemoryShadowConnection, MemoryShadowFailure } from "./manager-shadow-task.js";
import type { MemorySourceIndexHeader } from "./manager-source-index-kernel.js";
import type { refreshMemorySourceOrigin } from "./manager-source-origin.worker.js";
import type {
  loadMemorySourceFileState,
  refreshMemorySessionSourceState,
} from "./manager-source-state.js";

export type MemoryPublicationConnection = MemoryShadowConnection | { kind: "agent" };
export type MemoryPublicationState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
  extensionPath?: string;
};
export type MemoryPublicationFragment = { json: string; last: boolean };
export type MemoryEmbeddingCacheEntry = {
  hash: string;
  embedding: number[];
  sessionId?: string;
};
export type MemoryEmbeddingCacheHeader = {
  agentId: string;
  provider: { id: string; model: string };
  providerKey: string;
  maxEntries?: number;
};
export type MemoryEmbeddingCacheMutation =
  | { kind: "upsert"; header: MemoryEmbeddingCacheHeader; entries: MemoryEmbeddingCacheEntry[] }
  | { kind: "clear"; identities: MemoryIndexProviderIdentity[] };
export type MemoryPublicationResult<T> =
  | { ok: true; value: T; facts?: MemoryDatabaseFacts; writeToken?: string }
  | { ok: false; error: MemoryShadowFailure; entered: boolean; committed: boolean };
export type MemoryPublicationOperations = {
  "connection.inspect": { input: undefined; output: MemoryShadowConnection };
  "vector.ensure": {
    input: { dimensions: number; currentDimensions?: number; state: MemoryPublicationState };
    output: MemoryPublicationResult<void>;
  };
  "vector.prepare": {
    input: { state: MemoryPublicationState };
    output: MemoryPublicationResult<{ extensionPath: string; retiredLegacy: boolean }>;
  };
  "index.facts": { input: undefined; output: MemoryDatabaseFacts };
  "index.writeMetadata": { input: MemoryIndexMeta; output: MemoryPublicationResult<void> };
  "schema.admit": {
    input: Pick<
      Parameters<typeof ensureMemoryIndexSchema>[0],
      "cacheEnabled" | "ftsEnabled" | "ftsTokenizer"
    >;
    output: MemoryPublicationResult<ReturnType<typeof ensureMemoryIndexSchema>>;
  };
  "source.refresh": {
    input: Parameters<typeof refreshMemorySessionSourceState>[1];
    output: MemoryPublicationResult<boolean>;
  };
  "source.refreshOrigin": {
    input: Parameters<typeof refreshMemorySourceOrigin>[1];
    output: MemoryPublicationResult<boolean>;
  };
  "source.state": {
    input: Omit<Parameters<typeof loadMemorySourceFileState>[0], "db">;
    output: ReturnType<typeof loadMemorySourceFileState>;
  };
  "cache.read": {
    input: Omit<Parameters<typeof loadMemoryEmbeddingCache>[0], "db">;
    output: ReturnType<typeof loadMemoryEmbeddingCache>;
  };
  "source.hash": {
    input: { source: "memory" | "sessions"; path: string };
    output: string | undefined;
  };
  "source.chunks": {
    input: { source: "memory" | "sessions"; path: string };
    output: Array<{ id: string; embedded: boolean }>;
  };
  "session.current": {
    input: { agentId: string; sessionId: string };
    output: "current" | "forgotten";
  };
  "cache.prune": {
    input: { maxEntries: number };
    output: MemoryPublicationResult<boolean>;
  };
  "cache.stage.start": {
    input: { header: MemoryEmbeddingCacheHeader };
    output: void;
  };
  "cache.write": {
    input: { expectedRevision: number };
    output: MemoryPublicationResult<boolean>;
  };
  "cache.write.inline": {
    input: {
      header: MemoryEmbeddingCacheHeader;
      entries: MemoryEmbeddingCacheEntry[];
      expectedRevision: number;
    };
    output: MemoryPublicationResult<boolean>;
  };
  "cache.clear": {
    input: { identities: MemoryIndexProviderIdentity[]; expectedRevision: number };
    output: MemoryPublicationResult<boolean>;
  };
  "stage.start": {
    input: { header: MemorySourceIndexHeader };
    output: void;
  };
  "stage.append": {
    input: { fragments: MemoryPublicationFragment[] };
    output: void;
  };
  "stage.discard": { input: undefined; output: void };
  "source.replace": {
    input: { state: MemoryPublicationState };
    output: MemoryPublicationResult<{
      beforeRevision: number;
      databaseRevision: number;
      retainedDrift: boolean;
    }>;
  };
  "source.replace.inline": {
    input: {
      header: MemorySourceIndexHeader;
      fragments: MemoryPublicationFragment[];
      state: MemoryPublicationState;
    };
    output: MemoryPublicationOperations["source.replace"]["output"];
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
