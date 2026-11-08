import type { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import type { MemoryDatabaseAdmission } from "./manager-database-admission.js";
import type {
  loadMemoryEmbeddingCache,
  MemoryEmbeddingCacheEvictionPreference,
} from "./manager-embedding-cache.js";
import type { MemoryRebuildEmbeddingQuery } from "./manager-rebuild-embeddings.js";
import type { MemoryIndexMeta, MemoryIndexProviderIdentity } from "./manager-reindex-state.js";
import type { MemoryDatabaseFacts } from "./manager-retrieval-read.js";
import type { MemoryShadowConnection, MemoryShadowFailure } from "./manager-shadow-task.js";
import type {
  MemorySourceIndexHeader,
  readMemorySourceChunks,
} from "./manager-source-index-kernel.js";
import type {
  loadMemorySourceFileState,
  refreshMemorySessionSourceState,
} from "./manager-source-state.js";

export const MEMORY_INDEX_WRITE_SCOPE = "memory-index";
export const MEMORY_EMBEDDING_CACHE_WRITE_SCOPE = "memory-embedding-cache";

export type MemoryPublicationConnection =
  | MemoryShadowConnection
  | { kind: "agent"; stageId?: string };
export type MemoryPublicationState = {
  vector: { enabled: boolean; available: boolean | null };
  fts: { enabled: boolean; available: boolean };
  hasVectorTable?: boolean;
  extensionPath?: string;
};
export type MemoryPublicationFragment = { json: string; last: boolean };
export type MemoryPublicationSchema = {
  fts: string | null;
  paths: string | null;
  vector: string | null;
};
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
  unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference;
};
export type MemoryEmbeddingCacheMutation =
  | { kind: "upsert"; header: MemoryEmbeddingCacheHeader; entries: MemoryEmbeddingCacheEntry[] }
  | { kind: "clear"; identities: MemoryIndexProviderIdentity[] };
export type MemoryPublicationResult<T> =
  | {
      ok: true;
      value: T;
      facts?: MemoryDatabaseFacts;
      searchSchema?: MemoryPublicationSchema;
      writeToken?: string;
    }
  | { ok: false; error: MemoryShadowFailure; entered: boolean; committed: boolean };
export type MemoryPublicationOperations = {
  "database.reset": { input: undefined; output: MemoryPublicationResult<boolean> };
  "database.stage.start": { input: undefined; output: MemoryPublicationResult<void> };
  "database.stage.discard": { input: { stageId: string }; output: void };
  "database.stage.publish": {
    input: { stageId?: string; expectedRevision: number; vectorIndexComplete: boolean };
    output: MemoryPublicationResult<void>;
  };
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
  "index.upgradeProviderKey": {
    input: { meta: MemoryIndexMeta; providerKey: string };
    output: MemoryPublicationResult<boolean>;
  };
  "index.writeMetadata": { input: MemoryIndexMeta; output: MemoryPublicationResult<void> };
  "schema.admit": {
    input: Pick<
      Parameters<typeof ensureMemoryIndexSchema>[0],
      "cacheEnabled" | "ftsEnabled" | "ftsTokenizer" | "fresh"
    >;
    output: MemoryPublicationResult<
      ReturnType<typeof ensureMemoryIndexSchema> & { admission?: MemoryDatabaseAdmission }
    >;
  };
  "source.refresh": {
    input: Parameters<typeof refreshMemorySessionSourceState>[1];
    output: MemoryPublicationResult<boolean>;
  };
  "source.state": {
    input: Omit<Parameters<typeof loadMemorySourceFileState>[0], "db">;
    output: ReturnType<typeof loadMemorySourceFileState>;
  };
  "cache.read": {
    input: Omit<Parameters<typeof loadMemoryEmbeddingCache>[0], "db"> & {
      cacheEnabled?: boolean;
      published?: MemoryRebuildEmbeddingQuery;
    };
    output: ReturnType<typeof loadMemoryEmbeddingCache>;
  };
  "source.hash": {
    input: { source: "memory" | "sessions"; path: string };
    output: string | undefined;
  };
  "source.chunks": {
    input: { source: "memory" | "sessions"; path: string };
    output: ReturnType<typeof readMemorySourceChunks>;
  };
  "cache.prune": {
    input: {
      maxEntries: number;
      unreferencedFirst?: MemoryEmbeddingCacheEvictionPreference;
      recount?: boolean;
    };
    output: MemoryPublicationResult<boolean>;
  };
  "cache.stage.start": {
    input: { header: MemoryEmbeddingCacheHeader };
    output: void;
  };
  "cache.write": {
    input: undefined;
    output: MemoryPublicationResult<boolean>;
  };
  "cache.write.inline": {
    input: {
      header: MemoryEmbeddingCacheHeader;
      entries: MemoryEmbeddingCacheEntry[];
    };
    output: MemoryPublicationResult<boolean>;
  };
  "cache.clear": {
    input: { identities: MemoryIndexProviderIdentity[] };
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
    output: MemoryPublicationResult<boolean>;
  };
  "source.replace.group": {
    input: {
      sources: Array<{ header: MemorySourceIndexHeader; fragments: MemoryPublicationFragment[] }>;
      state: MemoryPublicationState;
    };
    output: MemoryPublicationOperations["source.replace"]["output"];
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
      sourceSchema: MemoryPublicationSchema;
      vectorIndexComplete: boolean;
      state: MemoryPublicationState;
    };
    output: MemoryPublicationResult<void>;
  };
};
