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
} from "./compiled-cache.js";
import { resolveMemoryWikiConfig, type MemoryWikiPluginConfig } from "./config.js";
import {
  configureMemoryWikiImportRunStateStore,
  createMemoryWikiImportRunStateStore,
} from "./import-runs-state.js";
import {
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
} from "./source-sync-state.js";
import { initializeMemoryWikiVault } from "./vault.js";

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

    return { rootDir, config };
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
