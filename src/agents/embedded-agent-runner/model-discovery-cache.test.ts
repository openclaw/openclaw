/**
 * Tests for model discovery cache lifecycle, including cache-hit reuse
 * and hot-reload cache invalidation via resetModelDiscoveryCache.
 */
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolvedAgentDir = path.resolve("/tmp/.openclaw/agents/test-agent");

const mockDiscoverAuthStorage = vi.hoisted(() => vi.fn());
const mockDiscoverModels = vi.hoisted(() => vi.fn());

vi.mock("../agent-model-discovery.js", () => ({
  discoverAuthStorage: mockDiscoverAuthStorage,
  discoverModels: mockDiscoverModels,
}));

// Plugin catalog listing used by the discovery cache fingerprint.
vi.mock("../plugin-model-catalog.js", () => ({
  listPluginModelCatalogFiles: vi.fn(() => []),
}));

import {
  discoverCachedAgentStores,
  resetModelDiscoveryCache,
  resetModelDiscoveryCacheForTest,
} from "./model-discovery-cache.js";

function freshAuthStorage() {
  return { type: "file", resolvedDir: resolvedAgentDir } as never;
}

function freshModelRegistry() {
  return { find: vi.fn(() => null), list: vi.fn(() => []), models: new Map() } as never;
}

describe("model discovery cache", () => {
  afterEach(() => {
    mockDiscoverAuthStorage.mockReset();
    mockDiscoverModels.mockReset();
    resetModelDiscoveryCacheForTest();
  });

  it("returns cached stores on repeated requests with the same agentDir", () => {
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());

    const first = discoverCachedAgentStores({ agentDir: resolvedAgentDir });
    const second = discoverCachedAgentStores({ agentDir: resolvedAgentDir });

    // Same objects returned from cache (cache hit).
    expect(second.authStorage).toBe(first.authStorage);
    expect(second.modelRegistry).toBe(first.modelRegistry);
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(1);
    expect(mockDiscoverModels).toHaveBeenCalledTimes(1);
  });

  it("resetModelDiscoveryCache clears all cached entries", () => {
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());

    const first = discoverCachedAgentStores({ agentDir: resolvedAgentDir });
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(1);

    resetModelDiscoveryCache();

    // After cache clear, next request re-discovers.
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());
    const second = discoverCachedAgentStores({ agentDir: resolvedAgentDir });

    // New objects (cache miss after reset).
    expect(second.authStorage).not.toBe(first.authStorage);
    expect(second.modelRegistry).not.toBe(first.modelRegistry);
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(mockDiscoverModels).toHaveBeenCalledTimes(2);
  });

  it("resetModelDiscoveryCacheForTest delegates to resetModelDiscoveryCache", () => {
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());

    discoverCachedAgentStores({ agentDir: resolvedAgentDir });
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(1);

    resetModelDiscoveryCacheForTest();

    // After clear via the deprecated API, next request re-discovers.
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());
    discoverCachedAgentStores({ agentDir: resolvedAgentDir });

    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(mockDiscoverModels).toHaveBeenCalledTimes(2);
  });

  it("re-discovers after fingerprint change (different models.json)", () => {
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());

    const first = discoverCachedAgentStores({ agentDir: resolvedAgentDir });
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(1);

    // Simulate a fingerprint change by resolving to a different agent dir.
    const otherDir = path.resolve("/tmp/.openclaw/agents/test-agent-other");
    mockDiscoverAuthStorage.mockReturnValue(freshAuthStorage());
    mockDiscoverModels.mockReturnValue(freshModelRegistry());

    const second = discoverCachedAgentStores({ agentDir: otherDir });

    // Different cache key → fresh discovery.
    expect(second.authStorage).not.toBe(first.authStorage);
    expect(mockDiscoverAuthStorage).toHaveBeenCalledTimes(2);
    expect(mockDiscoverModels).toHaveBeenCalledTimes(2);
  });
});
