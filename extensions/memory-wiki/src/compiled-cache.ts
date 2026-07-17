// Memory Wiki compiled cache ownership and persistence.
import { createHash } from "node:crypto";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { WikiFreshnessLevel } from "./claim-health.js";
import type { ResolvedMemoryWikiConfig } from "./config.js";
import type { WikiPageKind, WikiPageSummary, WikiRelationship } from "./markdown.js";

export const LEGACY_MEMORY_WIKI_COMPILED_CACHE_PATHS = [
  ".openclaw-wiki/cache/agent-digest.json",
  ".openclaw-wiki/cache/claims.jsonl",
] as const;

const COMPILED_CACHE_NAMESPACE = "compiled-cache";
const COMPILED_CACHE_MAX_ENTRIES = 256;
const COMPILED_CACHE_MAX_BYTES_PER_ENTRY = 100 * 1024 * 1024;
const COMPILED_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const COMPILED_CACHE_VERSION = 1;

export type MemoryWikiCompiledDigestClaim = {
  id?: string;
  text: string;
  status: string;
  confidence?: number;
  freshnessLevel: WikiFreshnessLevel;
};

export type MemoryWikiCompiledDigestPage = {
  id?: string;
  title: string;
  kind: WikiPageKind;
  path: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases: string[];
  sourceIds: string[];
  questions: string[];
  contradictions: string[];
  privacyTier?: string;
  personCard?: WikiPageSummary["personCard"];
  bestUsedFor: string[];
  notEnoughFor: string[];
  relationshipCount: number;
  topRelationships: WikiRelationship[];
  claimCount: number;
  topClaims: MemoryWikiCompiledDigestClaim[];
};

export type MemoryWikiCompiledClaim = {
  id?: string;
  pageId?: string;
  pageTitle: string;
  pageKind: WikiPageKind;
  pagePath: string;
  pageType?: string;
  entityType?: string;
  canonicalId?: string;
  aliases?: string[];
  text: string;
  status?: string;
  confidence?: number;
  sourceIds?: string[];
  evidenceKinds?: string[];
  privacyTiers?: string[];
  freshnessLevel?: string;
  lastTouchedAt?: string;
};

export type MemoryWikiCompiledCacheSnapshot = {
  digest: {
    claimCount: number;
    contradictionCount: number;
    pages: MemoryWikiCompiledDigestPage[];
  };
  claims: MemoryWikiCompiledClaim[];
};

type CompiledCacheMetadata = {
  version: typeof COMPILED_CACHE_VERSION;
  ownerId: string;
  vaultPath: string;
  vaultGeneration: string;
  generation: string;
  encoding: "gzip-json";
};

type ActiveVault = {
  path: string;
  generation: string;
};

export type MemoryWikiCompiledCacheStore = {
  read(config: ResolvedMemoryWikiConfig): Promise<MemoryWikiCompiledCacheSnapshot | null>;
  write(config: ResolvedMemoryWikiConfig, snapshot: MemoryWikiCompiledCacheSnapshot): Promise<void>;
  delete(config: ResolvedMemoryWikiConfig): Promise<void>;
  deleteOwnersExcept(ownerIds: ReadonlySet<string>): Promise<number>;
};

let configuredStore: MemoryWikiCompiledCacheStore | undefined;
const activeVaults = new Map<string, ActiveVault>();

export function resolveMemoryWikiCompiledCacheOwnerId(config: ResolvedMemoryWikiConfig): string {
  if (config.vault.scope === "global") {
    return "global";
  }
  const agentId = config.agentId?.trim();
  if (!agentId) {
    throw new Error("Memory Wiki agent-scoped compiled cache requires an agent owner.");
  }
  return `agent:${agentId}`;
}

function ownerKey(ownerId: string): string {
  return `owner:${createHash("sha256").update(ownerId).digest("hex")}`;
}

function isMetadata(value: CompiledCacheMetadata | undefined): value is CompiledCacheMetadata {
  return (
    value?.version === COMPILED_CACHE_VERSION &&
    typeof value.ownerId === "string" &&
    typeof value.vaultPath === "string" &&
    typeof value.vaultGeneration === "string" &&
    typeof value.generation === "string" &&
    value.encoding === "gzip-json"
  );
}

export function activateMemoryWikiCompiledCacheOwner(
  config: ResolvedMemoryWikiConfig,
  generation: string,
): void {
  const normalizedGeneration = generation.trim();
  if (!normalizedGeneration) {
    throw new Error("Memory Wiki vault generation must not be empty.");
  }
  activeVaults.set(resolveMemoryWikiCompiledCacheOwnerId(config), {
    path: path.resolve(config.vault.path),
    generation: normalizedGeneration,
  });
}

export function deactivateMemoryWikiCompiledCacheOwnersExcept(ownerIds: ReadonlySet<string>): void {
  for (const ownerId of activeVaults.keys()) {
    if (!ownerIds.has(ownerId)) {
      activeVaults.delete(ownerId);
    }
  }
}

export function resetMemoryWikiCompiledCacheOwnersForTests(): void {
  activeVaults.clear();
}

function resolveActiveVault(config: ResolvedMemoryWikiConfig): ActiveVault | null {
  const active = activeVaults.get(resolveMemoryWikiCompiledCacheOwnerId(config));
  if (!active || active.path !== path.resolve(config.vault.path)) {
    return null;
  }
  return active;
}

function parseSnapshot(
  bytes: Uint8Array,
  generation: string,
): MemoryWikiCompiledCacheSnapshot | null {
  try {
    const serialized = gunzipSync(bytes).toString("utf8");
    if (createHash("sha256").update(serialized).digest("hex") !== generation) {
      return null;
    }
    const parsed = JSON.parse(serialized) as MemoryWikiCompiledCacheSnapshot;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !parsed.digest ||
      typeof parsed.digest !== "object" ||
      !Array.isArray(parsed.digest.pages) ||
      !Array.isArray(parsed.claims)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function createMemoryWikiCompiledCacheStore(
  openBlobStore: <TMetadata>(options: {
    namespace: string;
    maxEntries: number;
    maxBytesPerEntry: number;
    maxBytesPerNamespace: number;
    overflowPolicy: "evict-oldest";
  }) => PluginBlobStore<TMetadata>,
  options: { onReadError?: (error: unknown) => void } = {},
): MemoryWikiCompiledCacheStore {
  const store = openBlobStore<CompiledCacheMetadata>({
    namespace: COMPILED_CACHE_NAMESPACE,
    maxEntries: COMPILED_CACHE_MAX_ENTRIES,
    maxBytesPerEntry: COMPILED_CACHE_MAX_BYTES_PER_ENTRY,
    maxBytesPerNamespace: COMPILED_CACHE_MAX_BYTES,
    overflowPolicy: "evict-oldest",
  });
  async function deleteKey(key: string): Promise<void> {
    await store.delete(key);
  }

  return {
    async read(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const key = ownerKey(ownerId);
      const entry = await store.lookup(key).catch((error: unknown) => {
        options.onReadError?.(error);
        return undefined;
      });
      if (!entry) {
        return null;
      }
      const metadata = entry.metadata;
      const vaultPath = path.resolve(config.vault.path);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        return null;
      }
      if (!isMetadata(metadata) || metadata.ownerId !== ownerId) {
        return null;
      }
      // Every run binds the SQLite row to the lifecycle-owned vault generation.
      // Prompt assembly itself receives only the immutable prepared lines.
      if (metadata.vaultPath !== vaultPath || metadata.vaultGeneration !== activeVault.generation) {
        return null;
      }
      return parseSnapshot(entry.bytes, metadata.generation);
    },

    async write(config, snapshot) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      const vaultPath = path.resolve(config.vault.path);
      const activeVault = resolveActiveVault(config);
      if (!activeVault) {
        throw new Error(`Memory Wiki vault is not active: ${vaultPath}`);
      }
      const serialized = JSON.stringify(snapshot);
      const metadata: CompiledCacheMetadata = {
        version: COMPILED_CACHE_VERSION,
        ownerId,
        vaultPath,
        vaultGeneration: activeVault.generation,
        generation: createHash("sha256").update(serialized).digest("hex"),
        encoding: "gzip-json",
      };
      // Stable owner keys make SQLite's transactional upsert the atomic generation boundary.
      await store.register(ownerKey(ownerId), gzipSync(serialized), metadata);
    },

    async delete(config) {
      const ownerId = resolveMemoryWikiCompiledCacheOwnerId(config);
      await deleteKey(ownerKey(ownerId));
    },

    async deleteOwnersExcept(ownerIds) {
      let deleted = 0;
      for (const entry of await store.entries()) {
        const metadata = entry.metadata;
        if (isMetadata(metadata) && ownerIds.has(metadata.ownerId)) {
          continue;
        }
        await deleteKey(entry.key);
        deleted += 1;
      }
      return deleted;
    },
  };
}

export function configureMemoryWikiCompiledCacheStore(
  store: MemoryWikiCompiledCacheStore | undefined,
): void {
  configuredStore = store;
}

function requireConfiguredStore(): MemoryWikiCompiledCacheStore {
  if (!configuredStore) {
    throw new Error("Memory Wiki compiled cache store is not configured.");
  }
  return configuredStore;
}

export async function loadMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<MemoryWikiCompiledCacheSnapshot | null> {
  return await requireConfiguredStore().read(config);
}

export async function invalidateMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
): Promise<void> {
  await requireConfiguredStore().delete(config);
}

export async function writeMemoryWikiCompiledCache(
  config: ResolvedMemoryWikiConfig,
  snapshot: MemoryWikiCompiledCacheSnapshot,
): Promise<void> {
  await requireConfiguredStore().write(config, snapshot);
}
