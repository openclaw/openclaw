import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { PluginBlobEntry, PluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  resolvePreferredOpenClawTmpDir,
  tempWorkspace,
  type TempWorkspace,
} from "openclaw/plugin-sdk/temp-path";
import { afterEach, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import {
  configureMemoryWikiCompiledCacheStore,
  createMemoryWikiCompiledCacheStore,
  writeMemoryWikiCompiledCache,
  type MemoryWikiCompiledCacheSnapshot,
  type MemoryWikiCompiledDigestPage,
} from "./compiled-cache.js";
import {
  resolveMemoryWikiConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
} from "./import-runs-state.js";
import {
  appendMemoryWikiLog,
  hashMemoryWikiVaultSources,
  loadMemoryWikiValidatedVaultIdentity,
  loadMemoryWikiVaultIdentity,
} from "./log.js";
import { renderWikiMarkdown } from "./markdown.js";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

export function createCompiledDigestPage(
  overrides: Partial<MemoryWikiCompiledDigestPage> = {},
): MemoryWikiCompiledDigestPage {
  return {
    title: "Snapshot",
    kind: "entity",
    path: "entities/snapshot.md",
    aliases: [],
    sourceIds: [],
    questions: [],
    contradictions: [],
    bestUsedFor: [],
    notEnoughFor: [],
    relationshipCount: 0,
    topRelationships: [],
    claimCount: 0,
    topClaims: [],
    ...overrides,
  };
}

export function createChatGptConversation(user: string, assistant: string) {
  const message = (parent: string, role: string, text: string) => ({
    parent,
    message: { author: { role }, content: { parts: [text] } },
  });
  return {
    conversation_id: "12345678-1234-1234-1234-1234567890ab",
    title: "Travel preference check",
    create_time: 1_712_363_200,
    update_time: 1_712_366_800,
    current_node: "assistant-1",
    mapping: {
      root: {},
      "user-1": message("root", "user", user),
      "assistant-1": message("user-1", "assistant", assistant),
    },
  };
}

export function createCompiledSnapshot(
  digest: MemoryWikiCompiledCacheSnapshot["digest"] = {
    claimCount: 0,
    contradictionCount: 0,
    pages: [],
  },
): MemoryWikiCompiledCacheSnapshot {
  return {
    digest,
    claims: [],
    dashboards: {
      importInsights: {
        sourceType: "chatgpt",
        totalItems: 0,
        totalClusters: 0,
        clusters: [],
        truncated: false,
      },
      overview: {
        totalItems: 0,
        totalPages: 0,
        pageCounts: { synthesis: 0, entity: 0, concept: 0, source: 0, report: 0 },
        totalClaims: 0,
        totalQuestions: 0,
        totalContradictions: 0,
        clusters: [],
        truncated: false,
      },
    },
  };
}

// Publish through the normal journal without replacing the caller's owner or vault state.
export async function publishCompiledSnapshot(
  config: ResolvedMemoryWikiConfig,
  snapshot: MemoryWikiCompiledCacheSnapshot,
): Promise<string> {
  const publicationId = randomUUID();
  const reservationId = randomUUID();
  const parentPublicationId = (await loadMemoryWikiVaultIdentity(config.vault.path))
    .compiledCachePublicationId;
  const record = (details: Parameters<typeof appendMemoryWikiLog>[1]["details"]) =>
    appendMemoryWikiLog(config.vault.path, {
      type: "compile",
      timestamp: "2026-07-17T00:00:00.000Z",
      details,
    });
  await record({ compiledCacheReservationId: reservationId });
  await record({
    compiledCachePublicationId: publicationId,
    compiledCacheParentPublicationId: parentPublicationId,
    compiledCacheReservationId: reservationId,
    compiledCacheSourceGeneration: hashMemoryWikiVaultSources([]),
  });
  await writeMemoryWikiCompiledCache(
    config,
    snapshot,
    publicationId,
    parentPublicationId,
    async () => {},
    () => loadMemoryWikiValidatedVaultIdentity(config.vault.path),
  );
  return publicationId;
}

export function createMemoryKeyedStore<T>(values = new Map<string, unknown>()) {
  return {
    async register(key: string, value: T) {
      values.set(key, value);
    },
    async registerIfAbsent(key: string, value: T) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    lookup: async (key: string) => values.get(key) as T | undefined,
    async consume(key: string) {
      const value = values.get(key) as T | undefined;
      values.delete(key);
      return value;
    },
    delete: async (key: string) => values.delete(key),
    entries: async () =>
      [...values.entries()].map(([key, value]) => ({ key, value: value as T, createdAt: 0 })),
    clear: async () => values.clear(),
  };
}

function createMemoryBlobStore<T>() {
  const values = new Map<string, PluginBlobEntry<T>>();
  const deleteExpiredKey = (key: string) => {
    const entry = values.get(key);
    if (!entry?.expiresAt || entry.expiresAt > Date.now()) {
      return undefined;
    }
    values.delete(key);
    const { bytes: _bytes, ...info } = entry;
    return info;
  };
  const register = async (
    key: string,
    bytes: Uint8Array,
    metadata: T,
    opts?: { ttlMs?: number },
  ) => {
    values.set(key, {
      key,
      bytes,
      metadata,
      sizeBytes: bytes.byteLength,
      createdAt: Date.now(),
      ...(opts?.ttlMs ? { expiresAt: Date.now() + opts.ttlMs } : {}),
    });
  };
  return {
    register,
    async registerIfAbsent(key: string, bytes: Uint8Array, metadata: T, opts?: { ttlMs?: number }) {
      if (values.has(key)) {
        return false;
      }
      await register(key, bytes, metadata, opts);
      return true;
    },
    lookup: async (key: string) => values.get(key),
    entries: async () => [...values.values()].map(({ bytes: _bytes, ...entry }) => entry),
    delete: async (key: string) => values.delete(key),
    deleteExpiredKey: async (key: string) => deleteExpiredKey(key),
    deleteExpired: async () =>
      [...values.keys()].map(deleteExpiredKey).filter((entry) => entry !== undefined),
    clear: async () => values.clear(),
  };
}

export function createMemoryWikiTestHarness() {
  const tempWorkspaces: TempWorkspace[] = [];
  let compiledBlobStore = createMemoryBlobStore<unknown>();
  const sourceSyncEntries = new Map<string, unknown>();
  const importRunEntries = new Map<string, unknown>();

  function configureStateStores(): void {
    configureMemoryWikiSourceSyncStateStore(
      createMemoryWikiSourceSyncStateStore(<T>() => createMemoryKeyedStore<T>(sourceSyncEntries)),
    );
    configureMemoryWikiImportRunStateStore(
      createMemoryWikiImportRunStateStore(<T>() => createMemoryKeyedStore<T>(importRunEntries)),
    );
  }

  function configureCompiledCacheStore(): void {
    configureMemoryWikiCompiledCacheStore(
      createMemoryWikiCompiledCacheStore(
        <T>() => compiledBlobStore as unknown as PluginBlobStore<T>,
      ),
    );
  }

  afterEach(async () => {
    configureMemoryWikiCompiledCacheStore(undefined);
    configureMemoryWikiSourceSyncStateStore(undefined);
    configureMemoryWikiImportRunStateStore(undefined);
    sourceSyncEntries.clear();
    importRunEntries.clear();
    compiledBlobStore = createMemoryBlobStore<unknown>();
    await Promise.all(tempWorkspaces.splice(0).map((workspace) => workspace.cleanup()));
  });

  // openclaw-temp-dir: allow this shared harness couples workspace cleanup to cache and vault lifecycle.
  async function createTempDir(prefix: string): Promise<string> {
    configureCompiledCacheStore();
    configureStateStores();
    const workspace = await tempWorkspace({
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix,
    });
    tempWorkspaces.push(workspace);
    return workspace.dir;
  }

  async function createVault(
    options: {
      prefix?: string;
      rootDir?: string;
      config?: MemoryWikiPluginConfig;
      initialize?: boolean;
    } = {},
  ) {
    configureCompiledCacheStore();
    configureStateStores();
    const rootDir = options.rootDir ?? (await createTempDir(options.prefix ?? "memory-wiki-test-"));
    const config = resolveMemoryWikiConfig(
      {
        ...options.config,
        vault: { ...options.config?.vault, path: rootDir },
      },
      { homedir: "/Users/tester" },
    );

    if (options.initialize) {
      await initializeMemoryWikiVault(config);
    }

    const write = async (relativePath: string, content: string | Buffer) => {
      const target = path.join(rootDir, relativePath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
      return target;
    };
    const page = (
      relativePath: string,
      frontmatter: Record<string, unknown>,
      body = `# ${String(frontmatter.title)}\n`,
    ) => write(relativePath, renderWikiMarkdown({ frontmatter, body }));
    const read = (relativePath: string) => fs.readFile(path.join(rootDir, relativePath), "utf8");
    return { rootDir, config, write, page, read };
  }

  function createPluginApi() {
    const registrations = {
      registerCli: vi.fn(),
      registerGatewayMethod: vi.fn(),
      registerMemoryCorpusSupplement: vi.fn(),
      registerMemoryPromptPreparation: vi.fn(),
      registerMemoryPromptSupplement: vi.fn(),
      registerService: vi.fn(),
      registerTool: vi.fn(),
    };
    const api = createTestPluginApi({
      id: "memory-wiki",
      name: "Memory Wiki",
      source: "test",
      config: {},
      runtime: {
        config: { current: () => ({}) },
        state: {
          openKeyedStore: vi.fn(<T>() => createMemoryKeyedStore<T>()),
          openBlobStore: vi.fn(<T>() => createMemoryBlobStore<T>()),
        },
      } as unknown as OpenClawPluginApi["runtime"],
      ...registrations,
    });

    return { api, ...registrations };
  }

  return {
    configureCompiledCacheStore,
    createPluginApi,
    createTempDir,
    createVault,
  };
}
