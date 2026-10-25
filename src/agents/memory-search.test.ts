import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveRememberAcrossConversations } from "../memory-host-sdk/host/config-utils.js";
import {
  clearEmbeddingProviders,
  registerEmbeddingProvider,
} from "../plugins/embedding-providers.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import {
  SecretSurfaceUnavailableError,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { resolveMemorySearchConfig, resolveMemorySearchSyncConfig } from "./memory-search.js";

type Search = NonNullable<OpenClawConfig["memory"]>["search"];
const multimodalSearch = (overrides: Search = {}): Search => ({
  provider: "gemini",
  model: "gemini-embedding-2-preview",
  multimodal: { enabled: true, modalities: ["image"] },
  ...overrides,
});
const asConfig = (cfg: OpenClawConfig): OpenClawConfig => ({
  ...cfg,
  // Keep pure config cases independent of plugin loading.
  plugins: cfg.plugins ?? { enabled: false },
});

const registerProvider = (id: string, defaultModel: string, transport: "remote" | "local") =>
  registerEmbeddingProvider({
    id,
    defaultModel,
    transport,
    create: async () => ({ provider: null }),
  });

function registerBaseMemoryEmbeddingProviders(options?: { includeGemini?: boolean }): void {
  for (const [id, defaultModel] of [
    ["openai", "text-embedding-3-small"],
    ["ollama", "nomic-embed-text"],
  ] as const) {
    registerProvider(id, defaultModel, "remote");
  }
  if (options?.includeGemini !== false) {
    registerEmbeddingProvider({
      id: "gemini",
      defaultModel: "gemini-embedding-001",
      transport: "remote",
      supportsMultimodalEmbeddings: ({ model }) =>
        model
          .trim()
          .replace(/^models\//, "")
          .replace(/^(gemini|google)\//, "") === "gemini-embedding-2-preview",
      create: async () => ({ provider: null }),
    });
  }
}

describe("memory search config", () => {
  beforeEach(({ onTestFinished }) => {
    const previous = captureActivePluginRegistrySnapshot();
    onTestFinished(() => rollbackStagedPluginRegistry(previous));
    stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
    registerBaseMemoryEmbeddingProviders();
  });

  afterEach(() => setActiveDegradedSecretOwners([]));

  function searchConfig(search: Search, overrides?: Search, agentId = "main"): OpenClawConfig {
    return asConfig({
      memory: { search },
      ...(overrides && {
        agents: { defaults: {}, entries: { [agentId]: { memory: { search: overrides } } } },
      }),
    });
  }

  const resolve = (...args: Parameters<typeof searchConfig>) =>
    resolveMemorySearchConfig(searchConfig(...args), args[2] ?? "main");

  it("returns null when disabled", () => {
    expect(resolve({ enabled: true }, { enabled: false })).toBeNull();
  });

  it("throws the typed unavailable error only for the degraded agent owner", () => {
    const cfg = asConfig({ agents: { entries: { cold: {}, healthy: {} } } });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: runtimeMemorySecretOwnerId("cold"),
        state: "unavailable",
        paths: ["memory.search.remote.apiKey"],
        refKeys: ["env:default:MISSING_MEMORY_KEY"],
        reason: "secret reference was not found",
      },
    ]);

    expect(() => resolveMemorySearchConfig(cfg, "cold")).toThrow(SecretSurfaceUnavailableError);
    expect(resolveMemorySearchConfig(cfg, "healthy")?.enabled).toBe(true);
  });

  it("returns null sync config when disabled", () => {
    expect(
      resolveMemorySearchSyncConfig(searchConfig({ enabled: true }, { enabled: false }), "main"),
    ).toBeNull();
  });

  it.each<[string, OpenClawConfig, boolean]>([
    [
      "unset with main scope and a binding override",
      {
        session: { dmScope: "main" },
        bindings: [
          { agentId: "main", match: { channel: "telegram" }, session: { dmScope: "per-peer" } },
        ],
      },
      false,
    ],
    [
      "explicit true with per-peer scope",
      {
        session: { dmScope: "per-peer" },
        memory: { search: { rememberAcrossConversations: true } },
      },
      true,
    ],
  ])("resolves remember-across-conversations for %s", (_name, cfg, expected) => {
    expect(resolveRememberAcrossConversations(asConfig(cfg), "main")).toBe(expected);
  });

  it("keeps cross-conversation recall off by default for isolated DMs", () => {
    const resolved = resolveMemorySearchConfig(
      asConfig({ session: { dmScope: "per-channel-peer" } }),
      "main",
    );

    expect(resolved).toMatchObject({
      rememberAcrossConversations: false,
      experimental: { sessionMemory: false },
      sources: ["memory"],
    });
  });

  it.each<[string, Search, Search, Record<string, unknown>]>([
    [
      "agent transcript opt-in",
      {},
      { rememberAcrossConversations: true, sources: ["sessions"] },
      { sources: ["sessions"], searchSources: ["sessions"] },
    ],
    [
      "legacy auto provider",
      { provider: "auto" },
      undefined,
      { provider: "openai", model: "text-embedding-3-small" },
    ],
    [
      "input type overrides",
      { provider: "openai", inputType: "passage", queryInputType: "query" },
      { documentInputType: "document" },
      { inputType: "passage", queryInputType: "query", documentInputType: "document" },
    ],
    [
      "session source exclusion",
      { provider: "openai", sources: ["memory", "sessions"] },
      { rememberAcrossConversations: false },
      { sources: ["memory"], sessionSourceExcluded: true },
    ],
  ])("resolves %s", (_name, defaults, overrides, expected) => {
    expect(resolve(defaults, overrides, "personal")).toMatchObject(expected);
  });

  it.each([
    [undefined, "search_query: "],
    ["Instruct: Retrieve notes\nQuery: ", "Instruct: Retrieve notes\nQuery: "],
    ["", undefined],
  ])("preserves literal query instruction override %j", (queryInstruction, expected) => {
    const resolved = resolve({ queryInstruction: "search_query: " }, { queryInstruction });
    expect(resolved?.queryInstruction).toBe(expected);
  });

  it("resolves providers from the generic embedding provider registry", () => {
    registerProvider("generic-local", "local-gguf-default", "local");

    expect(resolve({ provider: "generic-local" })).toMatchObject({
      provider: "generic-local",
      model: "local-gguf-default",
      remote: undefined,
    });
  });

  it("skips multimodal provider discovery for provider-none", () => {
    const resolved = resolveMemorySearchConfig(
      asConfig({
        plugins: { enabled: true },
        memory: {
          search: { provider: "none", multimodal: { enabled: true, modalities: ["image"] } },
        },
      }),
      "main",
    );

    expect(resolved).toMatchObject({ provider: "none", multimodal: { modalities: ["image"] } });
  });

  it("keeps resolved defaults isolated across calls and sync-only consumers", () => {
    const cfg = searchConfig({ provider: "openai" });
    const resolved = resolveMemorySearchConfig(cfg, "main")!;
    const expected = structuredClone(resolved);
    expect(resolved.cache).toStrictEqual({ enabled: true, maxEntries: 50_000 });

    resolved.chunking.tokens = 1;
    resolved.chunking.overlap = 0;
    resolved.sync.watch = false;
    resolved.sync.sessions.deltaBytes = 0;
    resolved.query.hybrid.vectorWeight = 0;
    resolved.query.hybrid.mmr.lambda = 0;
    resolved.query.hybrid.temporalDecay.halfLifeDays = 1;
    resolved.cache.enabled = false;

    expect(resolveMemorySearchConfig(cfg, "main")).toStrictEqual(expected);
    expect(resolveMemorySearchSyncConfig(cfg, "main")).toStrictEqual(expected.sync);
  });

  it("merges defaults and overrides", () => {
    const resolved = resolve(
      {
        provider: "openai",
        model: "text-embedding-3-small",
        store: { vector: { extensionPath: "/opt/sqlite-vec.dylib" } },
        query: { maxResults: 4, minScore: 0.2 },
      },
      { query: { maxResults: 8 } },
    );
    expect(resolved).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      query: { maxResults: 8, minScore: 0.2 },
      store: { vector: { enabled: true, extensionPath: "/opt/sqlite-vec.dylib" } },
    });
    expect(resolved?.query.hybrid.mmr).toEqual({ enabled: true, lambda: 0.7 });
  });

  it("merges extra memory paths from defaults and overrides", () => {
    // Pattern identity/normalization is owned by memory-host-sdk's config-utils tests.
    expect(resolve({ extraPaths: ["shared"] }, { extraPaths: ["agent"] })?.extraPaths).toEqual([
      "shared",
      "agent",
    ]);
  });

  it("normalizes multimodal settings", () => {
    const resolved = resolve(
      multimodalSearch({
        multimodal: { enabled: true, modalities: ["all"], maxFileBytes: 8192 },
      }),
    );
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: ["image", "audio"],
      maxFileBytes: 8192,
    });
  });

  it.each<[string, Search, RegExp]>([
    [
      "unsupported provider",
      { provider: "openai", model: "text-embedding-3-small" },
      /memory\.search\.multimodal requires a provider adapter that supports multimodal embeddings/,
    ],
    [
      "fallback",
      { fallback: "openai" },
      /memory\.search\.multimodal does not support memory\.search\.fallback/,
    ],
  ])("rejects multimodal memory with %s", (_name, overrides, error) => {
    expect(() => resolve(multimodalSearch(overrides))).toThrow(error);
  });

  it("accepts Gemini multimodal memory even when the runtime registry has not registered Gemini yet", () => {
    clearEmbeddingProviders();
    registerBaseMemoryEmbeddingProviders({ includeGemini: false });
    const resolved = resolve(multimodalSearch());
    expect(resolved?.provider).toBe("gemini");
    expect(resolved?.multimodal).toEqual({
      enabled: true,
      modalities: ["image"],
      maxFileBytes: 10 * 1024 * 1024,
    });
  });

  it("preserves SecretRef remote apiKey when merging defaults with agent overrides", () => {
    const resolved = resolve(
      {
        provider: "openai",
        remote: {
          apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
          headers: { "X-Default": "on" },
        },
      },
      { remote: { baseUrl: "https://agent.example/v1" } },
    );

    expect(resolved?.remote).toEqual({
      baseUrl: "https://agent.example/v1",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      headers: { "X-Default": "on" },
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    });
  });

  it.each([
    { search: { experimental: { sessionMemory: true } }, enabledBy: "sessionMemory" },
    { search: { rememberAcrossConversations: true }, enabledBy: "conversation recall" },
  ])("keeps a requested session source when $enabledBy is enabled", ({ search }) => {
    const resolved = resolve({ sources: ["memory", "sessions"], ...search });

    expect(resolved?.searchSources).toContain("sessions");
    expect(resolved?.sessionSourceExcluded).toBe(false);
  });
});
