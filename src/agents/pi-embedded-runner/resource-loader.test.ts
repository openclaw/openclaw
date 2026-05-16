import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPiResourceLoader,
  EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  getResourceLoaderCacheSize,
  invalidateResourceLoaderCache,
  markResourceLoaderReloaded,
  pruneResourceLoaderCache,
} from "./resource-loader.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader(
    this: Record<string, unknown>,
    options: unknown,
  ) {
    Object.assign(this, {
      options,
      reload: vi.fn(async () => undefined),
    });
  }),
}));

describe("createEmbeddedPiResourceLoader", () => {
  beforeEach(() => {
    // Clear cache before each test
    invalidateResourceLoaderCache();
    // Reset mock call count
    vi.clearAllMocks();
  });

  afterEach(() => {
    invalidateResourceLoaderCache();
  });

  it("keeps inline extensions but disables Pi filesystem discovery", () => {
    const settingsManager = {};
    const extensionFactories = [vi.fn()];

    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: extensionFactories as never,
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager,
      extensionFactories,
      ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
    });
  });

  it("caches resource loader for repeated calls with same cwd/agentDir", () => {
    const settingsManager = {};

    // First call creates new loader
    const loader1 = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: [],
    });

    // Second call should return cached loader (no new DefaultResourceLoader call)
    const loader2 = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: [],
    });

    // Should be same instance
    expect(loader1).toBe(loader2);
    // Should only create one DefaultResourceLoader
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(1);
  });

  it("creates separate loaders for different workspaces", () => {
    const loader1 = createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    const loader2 = createEmbeddedPiResourceLoader({
      cwd: "/workspace2",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    // Should be different instances
    expect(loader1).not.toBe(loader2);
    // Should create two DefaultResourceLoader
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(2);
  });

  it("creates separate loaders for different agentDirs", () => {
    const loader1 = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent1",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    const loader2 = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent2",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    expect(loader1).not.toBe(loader2);
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(2);
  });

  it("cache size tracks number of cached loaders", () => {
    expect(getResourceLoaderCacheSize()).toBe(0);

    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(1);

    createEmbeddedPiResourceLoader({
      cwd: "/workspace2",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(2);

    // Same workspace should not increase cache size
    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(2);
  });

  it("invalidateResourceLoaderCache clears all entries", () => {
    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    createEmbeddedPiResourceLoader({
      cwd: "/workspace2",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(2);

    invalidateResourceLoaderCache();
    expect(getResourceLoaderCacheSize()).toBe(0);

    // After invalidate, should create new loader
    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(3);
  });

  it("invalidateResourceLoaderCache with specific cwd/agentDir only removes that entry", () => {
    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent1",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    createEmbeddedPiResourceLoader({
      cwd: "/workspace2",
      agentDir: "/agent2",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(2);

    invalidateResourceLoaderCache("/workspace1", "/agent1");
    expect(getResourceLoaderCacheSize()).toBe(1);

    // workspace1 should create new loader
    createEmbeddedPiResourceLoader({
      cwd: "/workspace1",
      agentDir: "/agent1",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(3);

    // workspace2 should still use cached loader
    createEmbeddedPiResourceLoader({
      cwd: "/workspace2",
      agentDir: "/agent2",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(3); // No new call
  });

  it("markResourceLoaderReloaded updates lastReloadAt timestamp", () => {
    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    // Should not throw
    markResourceLoaderReloaded("/workspace", "/agent");
  });

  it("pruneResourceLoaderCache removes expired entries when TTL env is set", () => {
    // Set very short TTL for test
    process.env.OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS = "100";

    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(getResourceLoaderCacheSize()).toBe(1);

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    pruneResourceLoaderCache();
    expect(getResourceLoaderCacheSize()).toBe(0);

    // After prune, should create new loader
    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(2);

    // Clean up env
    delete process.env.OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS;
  });

  it("respects OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS env var", () => {
    // Set TTL to 10 seconds (minimum)
    process.env.OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS = "10000";

    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(1);

    // Immediate second call should use cache
    createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(1);

    // Clean up env
    delete process.env.OPENCLAW_RESOURCE_LOADER_CACHE_TTL_MS;
  });
});