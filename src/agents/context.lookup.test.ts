import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextWindowCatalog } from "./context-cache-projection.js";
import { replaceDiscoveredContextTokenCache } from "./context-cache.js";
import { CONTEXT_WINDOW_RUNTIME_STATE } from "./context-runtime-state.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";

const state = vi.hoisted(() => {
  const initialConfig: OpenClawConfig = {};
  const catalog: ContextWindowCatalog = { entries: [], staticEntries: [] };
  return {
    config: initialConfig,
    catalog,
    loadConfig: vi.fn<() => OpenClawConfig>(),
    loadOwner: vi.fn<(_params: unknown) => Promise<{ modelCatalog: ContextWindowCatalog }>>(),
    publishedOwner: vi.fn<
      (_params: unknown) =>
        | {
            config: OpenClawConfig;
            modelCatalog: ContextWindowCatalog;
          }
        | undefined
    >(),
  };
});

vi.mock("../config/config.js", () => ({ getRuntimeConfig: state.loadConfig }));
vi.mock("../config/runtime-source-projection.js", () => ({
  projectConfigOntoRuntimeSourceSnapshot: (snapshot: OpenClawConfig) => snapshot,
}));
vi.mock("./prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: state.loadOwner,
  getPublishedPreparedModelCatalogOwnerSnapshot: state.publishedOwner,
}));

function model(id: string, contextWindow: number, contextTokens?: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    contextTokens,
    maxTokens: 4096,
  };
}

function config(provider: string, ...models: ModelDefinitionConfig[]): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl: "https://example.invalid", models } } } };
}

let context: typeof import("./context.js");

beforeAll(async () => {
  vi.resetModules();
  context = await import("./context.js");
});

beforeEach(() => {
  state.config = {};
  state.catalog = { entries: [], staticEntries: [] };
  state.loadConfig.mockReset().mockImplementation(() => state.config);
  state.loadOwner.mockReset().mockImplementation(async () => ({ modelCatalog: state.catalog }));
  state.publishedOwner.mockReset().mockImplementation(() => ({
    config: state.config,
    modelCatalog: state.catalog,
  }));
  resetContextWindowCacheForTest();
});

afterEach(() => {
  resetContextWindowCacheForTest();
  vi.useRealTimers();
});

describe("context cache lifecycle", () => {
  it("rehydrates configured entries after module reload without rereading config", async () => {
    state.config = config("openrouter", model("openrouter/claude-sonnet", 321_000));
    expect(context.lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false })).toBe(
      321_000,
    );
    expect(state.loadConfig).toHaveBeenCalledTimes(1);

    vi.resetModules();
    state.loadConfig.mockReset().mockImplementation(() => {
      throw new Error("config should come from shared runtime state");
    });
    const reloaded = await import("./context.js");
    expect(
      reloaded.lookupContextTokens("openrouter/claude-sonnet", { allowAsyncLoad: false }),
    ).toBe(321_000);
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("retries config loading only after backoff", async () => {
    vi.useFakeTimers();
    state.config = config("openrouter", model("openrouter/claude-sonnet", 654_321));
    state.loadConfig.mockImplementationOnce(() => {
      throw new Error("transient");
    });
    expect(context.lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
    expect(state.loadConfig).toHaveBeenCalledTimes(1);
    expect(context.lookupContextTokens("openrouter/claude-sonnet")).toBeUndefined();
    expect(state.loadConfig).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.lookupContextTokens("openrouter/claude-sonnet")).toBe(654_321);
    expect(state.loadConfig).toHaveBeenCalledTimes(2);
    await context.ensureContextWindowCacheLoaded();
  });

  it("replaces configured token overrides before refreshing discovery", async () => {
    state.config = config("openrouter", model("claude-sonnet", 321_000, 111_000));
    expect(context.lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(111_000);
    state.catalog.entries = [
      { provider: "openrouter", id: "claude-sonnet", contextWindow: 654_321 },
    ];
    const pending = context.refreshContextWindowCache(
      config("openrouter", model("claude-sonnet", 222_000)),
    );
    expect(context.lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
    await pending;
    expect(context.lookupContextTokens("claude-sonnet", { allowAsyncLoad: false })).toBe(222_000);
  });

  it("loads exact read-only metadata rather than the Gateway-published owner", async () => {
    const cfg = config("anthropic", model("claude-opus-4.7-20260219", 200_000));
    state.catalog.entries = [
      {
        id: "anthropic/claude-opus-4.7-20260219",
        provider: "anthropic",
        contextWindow: 200_000,
      },
    ];
    await context.ensureContextWindowCacheLoaded(cfg);
    expect(state.loadOwner).toHaveBeenCalledWith({ config: cfg, readOnly: true });
    expect(state.publishedOwner).not.toHaveBeenCalled();
    expect(
      context.lookupContextTokens("anthropic/claude-opus-4.7-20260219", { allowAsyncLoad: false }),
    ).toBe(1_000_000);
  });

  it("warms configured, discovered, and static windows from the published owner", async () => {
    const requested = config("synthetic", model("stale-model", 111_000));
    state.config = config("synthetic", model("current-model", 222_000));
    state.catalog = {
      entries: [{ id: "discovered-model", provider: "synthetic", contextWindow: 64_000 }],
      staticEntries: [{ id: "static-model", provider: "google", contextWindow: 1_048_576 }],
    };
    await context.prewarmContextWindowCacheAfterReady({ config: requested });
    expect(state.publishedOwner).toHaveBeenCalledWith({
      config: requested,
      allowGatewaySubagentBinding: true,
    });
    expect(state.loadOwner).not.toHaveBeenCalled();
    const options = { allowAsyncLoad: false, skipRuntimeConfigLoad: true };
    expect(context.lookupContextTokens("current-model", options)).toBe(222_000);
    expect(context.lookupContextTokens("discovered-model", options)).toBe(64_000);
    expect(context.lookupContextTokens("static-model", options)).toBe(1_048_576);
    expect(context.lookupContextTokens("stale-model", options)).toBeUndefined();
  });

  it("retires failed prewarm so exact request-time loading can recover", async () => {
    state.publishedOwner.mockReturnValueOnce(undefined);
    state.config = config("synthetic", model("recovered-model", 96_000));
    await context.prewarmContextWindowCacheAfterReady({ config: state.config });
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig).toBeUndefined();
    await context.ensureContextWindowCacheLoaded();
    expect(state.loadOwner).toHaveBeenCalledWith({ config: state.config, readOnly: true });
    expect(context.lookupContextTokens("recovered-model", { allowAsyncLoad: false })).toBe(96_000);
  });

  it("retires stale discovery when exact catalog loading fails", async () => {
    replaceDiscoveredContextTokenCache(new Map([["stale-model", 999_000]]));
    state.loadOwner.mockRejectedValueOnce(new Error("catalog unavailable"));
    await context.ensureContextWindowCacheLoaded(
      config("synthetic", model("current-model", 96_000)),
    );
    expect(
      context.lookupContextTokens("stale-model", { skipRuntimeConfigLoad: true }),
    ).toBeUndefined();
  });

  it("retires an unpublished prewarm marker when shutdown cancels during import", async () => {
    let cancelled = false;
    const pending = context.prewarmContextWindowCacheAfterReady({
      config: {},
      isCancelled: () => cancelled,
    });
    cancelled = true;
    await pending;
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadGeneration).toBeNull();
  });

  it("does not publish prewarm cancelled during cooperative projection", async () => {
    let cancelled = false;
    state.catalog.entries = Array.from({ length: 600 }, (_, index) => ({
      id: `cancelled-${index}`,
      contextWindow: 64_000,
    }));
    state.publishedOwner.mockImplementationOnce(() => {
      queueMicrotask(() => {
        cancelled = true;
      });
      return { config: state.config, modelCatalog: state.catalog };
    });

    await context.prewarmContextWindowCacheAfterReady({
      config: state.config,
      isCancelled: () => cancelled,
    });

    expect(cancelled).toBe(true);
    expect(
      context.lookupContextTokens("cancelled-599", { skipRuntimeConfigLoad: true }),
    ).toBeUndefined();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
  });

  it("releases status waits on timeout while warmup is pending", async () => {
    vi.useFakeTimers();
    state.loadOwner.mockImplementationOnce(() => new Promise<never>(() => {}));
    void context.ensureContextWindowCacheLoaded(config("anthropic", model("claude", 200_000)));
    const waiting = context.waitForContextWindowCacheLoad({ timeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    await expect(waiting).resolves.toBe("timeout");
  });
});

describe("provider-owned context lookup", () => {
  it("uses self-prefixed provider discovery ahead of the bare cross-provider minimum", async () => {
    state.catalog.entries = [
      { provider: "github-copilot", id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
      { id: "gemini-3.1-pro-preview", contextWindow: 128_000 },
      {
        provider: "google-gemini-cli",
        id: "google-gemini-cli/gemini-3.1-pro-preview",
        contextWindow: 1_048_576,
      },
    ];
    await context.ensureContextWindowCacheLoaded();
    expect(
      context.resolveContextTokensForModel({
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
      }),
    ).toBe(1_048_576);
    expect(context.lookupContextTokens("gemini-3.1-pro-preview")).toBe(128_000);
  });

  it("falls back to a bare configured row", () => {
    expect(
      context.resolveContextTokensForModel({
        cfg: config("kilocode", model("kilo-auto/balanced", 900_000, 900_000)),
        provider: "kilocode",
        model: "kilocode/kilo-auto/balanced",
      }),
    ).toBe(900_000);
  });

  it("treats explicit config as authoritative for read-only misses", () => {
    state.loadConfig.mockImplementation(() => {
      throw new Error("runtime config should not load");
    });
    expect(
      context.resolveContextTokensForModel({
        cfg: { agents: { defaults: {} } },
        provider: "openai",
        model: "unknown-test-model",
        fallbackContextTokens: 123_000,
        allowAsyncLoad: false,
      }),
    ).toBe(123_000);
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("does not confuse raw slash model ids with verified provider identity", async () => {
    state.catalog.entries = [
      { provider: "openrouter", id: "google/gemini-2.5-pro", contextWindow: 999_000 },
    ];
    await context.ensureContextWindowCacheLoaded();
    const cfg = config("google", model("gemini-2.5-pro", 2_000_000));
    expect(
      context.resolveContextTokensForModel({ cfg, provider: "google", model: "gemini-2.5-pro" }),
    ).toBe(2_000_000);
    expect(
      context.resolveContextTokensForModel({
        provider: "openrouter",
        model: "google/gemini-2.5-pro",
      }),
    ).toBe(999_000);
    expect(
      context.resolveContextTokensForModel({ provider: "google", model: "gemini-2.5-pro" }),
    ).toBeUndefined();
    expect(context.resolveContextTokensForModel({ cfg, model: "google/gemini-2.5-pro" })).toBe(
      999_000,
    );
  });
});
