import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmbeddedPiResourceLoader,
  createEmbeddedPiResourceLoaderSync,
  EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
  markResourceLoaderReloaded,
} from "./resource-loader.js";

// Mock DefaultResourceLoader to track construction and method calls
const mockLoadExtensionFactories = vi.fn(async (runtime: unknown) => ({
  extensions: [],
  errors: [],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader(
    this: Record<string, unknown>,
    options: unknown,
  ) {
    Object.assign(this, {
      options,
      extensionsResult: { extensions: [], errors: [], runtime: {} },
      loadExtensionFactories: mockLoadExtensionFactories,
    });
  }),
}));

describe("createEmbeddedPiResourceLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes correct options to DefaultResourceLoader including discovery flags", async () => {
    const settingsManager = {};
    const extensionFactories = [vi.fn()];

    await createEmbeddedPiResourceLoader({
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

  it("calls loadExtensionFactories directly without reload()", async () => {
    const settingsManager = {};

    await createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: settingsManager as never,
      extensionFactories: [],
    });

    // Should call loadExtensionFactories directly
    expect(mockLoadExtensionFactories).toHaveBeenCalledTimes(1);
    // Should not have a reload method called (we skip it entirely)
    // The mock doesn't have reload, so if it was called it would throw
  });

  it("loads inline extensionFactories into extensionsResult", async () => {
    const extensionFactories = [vi.fn(), vi.fn()];
    const mockExtensions = [{ name: "test-extension" }];
    
    mockLoadExtensionFactories.mockResolvedValueOnce({
      extensions: mockExtensions,
      errors: [],
    });

    const loader = await createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: extensionFactories as never,
    });

    // Extensions should be loaded into extensionsResult
    expect((loader as any).extensionsResult.extensions).toEqual(mockExtensions);
  });

  it("accumulates errors from loadExtensionFactories", async () => {
    const mockErrors = [{ path: "<inline:1>", error: "Failed to load" }];
    
    mockLoadExtensionFactories.mockResolvedValueOnce({
      extensions: [],
      errors: mockErrors,
    });

    const loader = await createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [vi.fn()] as never,
    });

    expect((loader as any).extensionsResult.errors).toEqual(mockErrors);
  });

  it("is async to allow extension factory loading", async () => {
    // createEmbeddedPiResourceLoader returns a Promise
    const result = createEmbeddedPiResourceLoader({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
      extensionFactories: [],
    });

    expect(result).toBeInstanceOf(Promise);
    await result; // Should resolve without error
  });
});

describe("createEmbeddedPiResourceLoaderSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates loader synchronously without extensionFactories", () => {
    const loader = createEmbeddedPiResourceLoaderSync({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
    });

    expect(loader).toBeDefined();
    expect(DefaultResourceLoader).toHaveBeenCalledTimes(1);
  });

  it("does not call loadExtensionFactories for sync version", () => {
    createEmbeddedPiResourceLoaderSync({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
    });

    // Sync version skips extension loading
    expect(mockLoadExtensionFactories).not.toHaveBeenCalled();
  });

  it("passes empty extensionFactories array", () => {
    createEmbeddedPiResourceLoaderSync({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {} as never,
    });

    expect(DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: "/workspace",
      agentDir: "/agent",
      settingsManager: {},
      extensionFactories: [],
      ...EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS,
    });
  });
});

describe("EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS", () => {
  it("disables all filesystem discovery", () => {
    expect(EMBEDDED_PI_RESOURCE_LOADER_DISCOVERY_OPTIONS).toEqual({
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
  });
});

describe("markResourceLoaderReloaded", () => {
  it("is a no-op that does not throw", () => {
    // Should not throw for any arguments
    markResourceLoaderReloaded("/workspace", "/agent");
    markResourceLoaderReloaded("", "");
    markResourceLoaderReloaded("any", "path");
    expect(true).toBe(true); // Explicit pass
  });
});