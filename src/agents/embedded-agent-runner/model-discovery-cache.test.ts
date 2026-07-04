/**
 * Tests for agent model-discovery cache — verifies cache invalidation on
 * config hot reload so include-defined models are not lost after reload.
 *
 * Root-cause (issue #99773):
 *   DISCOVERY_STORE_CACHE key and fingerprint only track file metadata
 *   (agentDir, auth SQLite WAL, models.json, plugin catalogs). They do NOT
 *   include the resolved config snapshot. When a config hot reload changes
 *   models.providers through config includes (OPENCLAIM_INCLUDE_ROOTS), file
 *   timestamps are unchanged, so the cache returns a stale ModelRegistry that
 *   predates the include merge.
 *
 * Fix:
 *   resetPreparedModelRuntimeStateForHotReload() now calls
 *   clearModelDiscoveryCache() alongside the existing resetModelCatalogCache()
 *   and clearCurrentProviderAuthState().
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelDiscoveryCache,
  discoverCachedAgentStores,
  resetModelDiscoveryCacheForTest,
} from "./model-discovery-cache.js";

// ---------------------------------------------------------------------------
// Mocks — model-discovery-cache imports discoverAuthStorage / discoverModels
// from agent-model-discovery, and synthetic-auth module helpers. We mock both
// to track call counts and control return values without file I/O.
// ---------------------------------------------------------------------------

const mockDiscoverAuthStorage = vi.hoisted(() => vi.fn());
const mockDiscoverModels = vi.hoisted(() => vi.fn());
const mockResolveRuntimeSyntheticAuthProviderRefs = vi.hoisted(
  () => vi.fn((): string[] => []),
);
const mockResolveRuntimeExternalAuthProviderRefs = vi.hoisted(
  () => vi.fn((): string[] => []),
);

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: mockDiscoverAuthStorage,
  discoverModels: mockDiscoverModels,
}));

vi.mock("../../plugins/synthetic-auth.runtime.js", () => ({
  resolveRuntimeSyntheticAuthProviderRefs: mockResolveRuntimeSyntheticAuthProviderRefs,
  resolveRuntimeExternalAuthProviderRefs: mockResolveRuntimeExternalAuthProviderRefs,
}));

function mockModelRegistry(entries: Array<{ provider: string; id: string }>) {
  const registry = {
    get: vi.fn(),
    getAll: vi.fn().mockReturnValue(entries.map((e) => ({ provider: e.provider, id: e.id }))),
    set: vi.fn(),
    remove: vi.fn(),
    getAllProviders: vi.fn().mockReturnValue([...new Set(entries.map((e) => e.provider))]),
  };
  return registry;
}

function mockAuthStorage() {
  return { mocked: true } as never;
}

const DEFAULT_AGENT_DIR = "/tmp/openclaw-test-agent";

describe("model-discovery-cache", () => {
  beforeEach(() => {
    resetModelDiscoveryCacheForTest();
    mockDiscoverAuthStorage.mockClear();
    mockDiscoverModels.mockClear();
    mockResolveRuntimeSyntheticAuthProviderRefs.mockReset();
    mockResolveRuntimeExternalAuthProviderRefs.mockReset();
    mockDiscoverAuthStorage.mockReturnValue(mockAuthStorage());
  });

  afterEach(() => {
    resetModelDiscoveryCacheForTest();
  });

  describe("clearModelDiscoveryCache", () => {
    it("forces fresh discovery on next call after cache was warm", () => {
      const initialRegistry = mockModelRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-6" },
      ]);
      mockDiscoverModels.mockReturnValue(initialRegistry);

      // First call — cache miss, fresh discovery.
      const first = discoverCachedAgentStores({ agentDir: DEFAULT_AGENT_DIR });
      expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
      expect(first.modelRegistry.getAll()).toHaveLength(1);

      // Second call with identical params — cache hit (file fingerprint
      // unchanged), discoverModels NOT called again.
      const second = discoverCachedAgentStores({ agentDir: DEFAULT_AGENT_DIR });
      expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
      expect(second.modelRegistry).toBe(first.modelRegistry); // same reference

      // === Act: clear the cache (simulating hot-reload fix) ===
      clearModelDiscoveryCache();

      // Third call — cache empty again, fresh discovery runs.
      const updatedRegistry = mockModelRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        {
          provider: "anthropic",
          id: "claude-opus-4-8",
        }, // include-defined model
      ]);
      mockDiscoverModels.mockReturnValue(updatedRegistry);

      const third = discoverCachedAgentStores({ agentDir: DEFAULT_AGENT_DIR });
      expect(mockDiscoverModels).toHaveBeenCalledTimes(2); // fresh call
      expect(third.modelRegistry.getAll()).toHaveLength(2);
      expect(third.modelRegistry).not.toBe(first.modelRegistry); // new instance
    });

    it("is idempotent — calling it on an already-empty cache does not throw", () => {
      resetModelDiscoveryCacheForTest(); // already empty
      expect(() => clearModelDiscoveryCache()).not.toThrow();
    });
  });

  describe("hot-reload integration — include-defined models survive after cache clear", () => {
    it("returns include-resolved models after clearModelDiscoveryCache", () => {
      // Simulate: before hot-reload the cache holds a registry with models A and B.
      const preReloadRegistry = mockModelRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "anthropic", id: "claude-opus-4-7" },
      ]);
      mockDiscoverModels.mockReturnValue(preReloadRegistry);

      const pre = discoverCachedAgentStores({ agentDir: DEFAULT_AGENT_DIR });
      expect(pre.modelRegistry.getAll()).toHaveLength(2);

      // === Hot reload happens: config includes resolved, adding model C. ===
      clearModelDiscoveryCache();

      const postReloadRegistry = mockModelRegistry([
        { provider: "anthropic", id: "claude-sonnet-4-6" },
        { provider: "anthropic", id: "claude-opus-4-7" },
        { provider: "anthropic", id: "claude-opus-4-8" }, // include-defined, added by hot-reload
      ]);
      mockDiscoverModels.mockReturnValue(postReloadRegistry);

      // Fresh resolution after cache clear picks up the new model.
      const post = discoverCachedAgentStores({ agentDir: DEFAULT_AGENT_DIR });
      expect(post.modelRegistry.getAll()).toHaveLength(3);

      // Verify the include-defined model is resolvable.
      const allModels = post.modelRegistry.getAll() as Array<{
        provider: string;
        id: string;
      }>;
      expect(allModels.some((m) => m.id === "claude-opus-4-8")).toBe(true);
    });
  });
});
