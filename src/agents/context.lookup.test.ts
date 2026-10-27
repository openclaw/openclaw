import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getContextWindowCaches, replaceDiscoveredContextTokenCache } from "./context-cache.js";
import { modelConfig } from "./context-config.test-support.js";
import { CONTEXT_WINDOW_RUNTIME_STATE } from "./context-runtime-state.js";
import {
  type ContextWindowCatalogFixture,
  resetContextWindowCacheForTest,
} from "./context.test-support.js";
type Owner = { config: OpenClawConfig; modelCatalog: ContextWindowCatalogFixture };

const state = vi.hoisted(() => {
  const initialConfig: OpenClawConfig = {};
  const catalog: ContextWindowCatalogFixture = { entries: [], staticEntries: [] };
  return {
    config: initialConfig,
    catalog,
    loadConfig: vi.fn<() => OpenClawConfig | null>(),
    loadOwner: vi.fn<(_params: unknown) => Promise<Pick<Owner, "modelCatalog">>>(),
    publishedOwner: vi.fn<(_params: unknown) => Owner | undefined>(),
  };
});

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfigSnapshot: state.loadConfig,
}));
vi.mock("../config/runtime-source-projection.js", () => ({
  projectConfigOntoRuntimeSourceSnapshot: (snapshot: OpenClawConfig) => snapshot,
}));
vi.mock("./prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: state.loadOwner,
  getPublishedPreparedModelCatalogOwnerSnapshot: state.publishedOwner,
}));

const config = (provider: string, id: string, contextWindow: number, contextTokens?: number) =>
  modelConfig(provider, id, { contextWindow, contextTokens });
const discovered = (id: string, contextWindow: number, provider?: string) => ({
  id,
  contextWindow,
  provider,
});
const sync = { allowAsyncLoad: false };
const sonnet = "openrouter/claude-sonnet";

let context: typeof import("./context.js");
function expectTokens(
  modelId: string,
  expected: number | undefined,
  options: Omit<Parameters<typeof context.resolveContextTokensForModel>[0], "model"> = {},
) {
  expect(context.resolveContextTokensForModel({ model: modelId, ...options })).toBe(expected);
}

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

afterEach(async () => {
  await CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  resetContextWindowCacheForTest();
  vi.useRealTimers();
});

describe("context cache lifecycle", () => {
  it("rehydrates configured entries after module reload without rereading config", async () => {
    state.config = config("openrouter", sonnet, 321_000);
    expectTokens(sonnet, 321_000, sync);
    expect(state.loadConfig).toHaveBeenCalledTimes(1);

    vi.resetModules();
    state.loadConfig.mockReset().mockImplementation(() => {
      throw new Error("config should come from shared runtime state");
    });
    const reloaded = await import("./context.js");
    expect(reloaded.resolveContextTokensForModel({ model: sonnet, ...sync })).toBe(321_000);
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("reads newly published context limits on the next lookup", async () => {
    const runtime = await import("../config/runtime-snapshot.js");
    const previous = runtime.getRuntimeConfigSnapshot();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    state.loadConfig.mockImplementation(runtime.getRuntimeConfigSnapshot);
    try {
      runtime.clearRuntimeConfigSnapshot();
      expectTokens(sonnet, undefined, sync);
      runtime.setRuntimeConfigSnapshot(config("openrouter", sonnet, 654_321));
      expectTokens(sonnet, 654_321, sync);
    } finally {
      if (previous) {
        runtime.setRuntimeConfigSnapshot(previous);
      } else {
        runtime.clearRuntimeConfigSnapshot();
      }
      clock.mockRestore();
    }
  });

  it("replaces configured token overrides before refreshing discovery", async () => {
    state.config = config("openrouter", "claude-sonnet", 321_000, 111_000);
    expectTokens("claude-sonnet", 111_000, sync);
    state.catalog.entries = [discovered("claude-sonnet", 654_321, "openrouter")];
    const pending = context.refreshContextWindowCache(
      config("openrouter", "claude-sonnet", 222_000),
    );
    expectTokens("claude-sonnet", 222_000, sync);
    await pending;
    expectTokens("claude-sonnet", 222_000, sync);
  });

  it("loads exact read-only metadata rather than the Gateway-published owner", async () => {
    const cfg = config("anthropic", "claude-opus-4.7-20260219", 200_000);
    state.catalog.entries = [
      discovered("anthropic/claude-opus-4.7-20260219", 200_000, "anthropic"),
    ];
    state.config = cfg;
    await context.ensureContextWindowCacheLoaded();
    expect(state.loadOwner).toHaveBeenCalledWith({ config: cfg, readOnly: true });
    expect(state.publishedOwner).not.toHaveBeenCalled();
    expectTokens("anthropic/claude-opus-4.7-20260219", 1_000_000, sync);
  });

  it.each(["success", "failure"])(
    "keeps refreshed discovery when an older load finishes with %s",
    async (outcome) => {
      const started = Promise.withResolvers<void>();
      const older = Promise.withResolvers<{ modelCatalog: ContextWindowCatalogFixture }>();
      state.loadOwner.mockImplementationOnce(() => {
        started.resolve();
        return older.promise;
      });
      const pending = context.ensureContextWindowCacheLoaded();
      await started.promise;

      state.catalog.entries = [discovered("new-model", 222_000, "synthetic")];
      await context.refreshContextWindowCache({});
      const options = { provider: "synthetic", allowAsyncLoad: false };
      expectTokens("new-model", 222_000, options);

      if (outcome === "failure") {
        older.reject(new Error("old catalog unavailable"));
      } else {
        older.resolve({
          modelCatalog: {
            entries: [discovered("old-model", 111_000, "synthetic")],
          },
        });
      }
      await pending;

      expectTokens("new-model", 222_000, options);
      expectTokens("old-model", undefined, options);
    },
  );

  it("warms configured, discovered, and static windows from the published owner", async () => {
    const requested = config("synthetic", "stale-model", 111_000);
    state.config = config("synthetic", "current-model", 222_000);
    state.catalog = {
      entries: [discovered("discovered-model", 64_000, "synthetic")],
      staticEntries: [discovered("static-model", 1_048_576, "google")],
    };
    await context.prewarmContextWindowCacheAfterReady({ config: requested });
    expect(state.publishedOwner).toHaveBeenCalledWith({
      config: requested,
      allowGatewaySubagentBinding: true,
    });
    expect(state.loadOwner).not.toHaveBeenCalled();
    const options = { allowAsyncLoad: false, cfg: {} };
    expectTokens("current-model", 222_000, options);
    expectTokens("discovered-model", 64_000, options);
    expectTokens("static-model", 1_048_576, options);
    expectTokens("stale-model", undefined, options);
  });

  it("retires failed prewarm so exact request-time loading can recover", async () => {
    state.publishedOwner.mockReturnValueOnce(undefined);
    state.config = config("synthetic", "recovered-model", 96_000);
    await context.prewarmContextWindowCacheAfterReady({ config: state.config });
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
    expect(CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig).toBeUndefined();
    await context.ensureContextWindowCacheLoaded();
    expect(state.loadOwner).toHaveBeenCalledWith({ config: state.config, readOnly: true });
    expectTokens("recovered-model", 96_000, sync);
  });

  it("retires stale discovery when exact catalog loading fails", async () => {
    replaceDiscoveredContextTokenCache(new Map([["stale-model", 999_000]]));
    state.loadOwner.mockRejectedValueOnce(new Error("catalog unavailable"));
    state.config = config("synthetic", "current-model", 96_000);
    await context.ensureContextWindowCacheLoaded();
    expectTokens("stale-model", undefined, { cfg: {} });
  });

  it("does not publish prewarm cancelled during cooperative projection", async () => {
    let cancelled = false;
    state.catalog.entries = Array.from({ length: 600 }, (_, index) =>
      discovered(`cancelled-${index}`, 64_000),
    );
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
    expectTokens("cancelled-599", undefined, { cfg: {} });
    expect(CONTEXT_WINDOW_RUNTIME_STATE.loadPromise).toBeNull();
  });

  it("keeps the prior generation visible until a cooperative prewarm is complete", async () => {
    const caches = getContextWindowCaches();
    caches.configuredTokenCache.set("prior-model", 48_000);
    state.config = config("synthetic", "next-model", 96_000);
    const entries = Array.from({ length: 600 }, (_, index) =>
      discovered(`discovered-${index}`, 64_000, "synthetic"),
    );
    const projecting = Promise.withResolvers<void>();
    state.catalog = {
      get entries() {
        queueMicrotask(() => projecting.resolve());
        return entries;
      },
      staticEntries: [],
    };
    const pending = context.prewarmContextWindowCacheAfterReady({ config: state.config });
    await projecting.promise;
    expectTokens("prior-model", 48_000, { cfg: {} });
    expectTokens("next-model", undefined, { cfg: {} });
    expectTokens("discovered-0", undefined, { cfg: {} });

    await pending;
    expectTokens("prior-model", undefined, { cfg: {} });
    expectTokens("next-model", 96_000, { cfg: {} });
    expectTokens("discovered-599", 64_000, { cfg: {} });
  });
});

describe("provider-owned context lookup", () => {
  it("keeps unowned CLI discovery at its reported window", async () => {
    state.catalog.entries = [{ id: "claude-cli/claude-opus-4.7-20260219", contextWindow: 200_000 }];
    await context.ensureContextWindowCacheLoaded();
    expectTokens("claude-cli/claude-opus-4.7-20260219", 200_000, sync);
  });

  it("does not replace unknown captured capacity with a sibling's bare cache", async () => {
    state.catalog.entries = [{ provider: "other", id: "shared-model", contextTokens: 128_000 }];
    await context.ensureContextWindowCacheLoaded();
    const selected = { cfg: {}, provider: "custom", ...sync };
    expectTokens("shared-model", 128_000, selected);
    expectTokens("shared-model", undefined, { ...selected, allowCacheLookup: false });
    expectTokens("shared-model", 32_000, {
      ...selected,
      allowCacheLookup: false,
      fallbackContextTokens: 32_000,
    });
  });

  it("can exclude unscoped discovery from provider-owned lookup", async () => {
    state.catalog.entries = [{ id: "large", contextTokens: 32_000 }];
    await context.ensureContextWindowCacheLoaded();
    expectTokens("large", undefined, {
      provider: "claude-cli",
      allowUnscopedModelLookup: false,
      ...sync,
    });
    expectTokens("large", 32_000, { provider: "claude-cli", ...sync });
  });

  it("keeps configured token caps authoritative over lower discovery", async () => {
    state.catalog.entries = [discovered("gpt-5.5", 272_000, "openai")];
    await context.ensureContextWindowCacheLoaded();
    context.resetContextWindowCache(config("openai", "gpt-5.5", 200_000, 350_000));
    expectTokens("gpt-5.5", 350_000, { provider: "openai", ...sync });
  });

  it("keeps provider discovery ahead of static caps under configured windows", async () => {
    state.catalog.entries = [{ provider: "openai", id: "gpt-5.5", contextTokens: 200_000 }];
    await context.ensureContextWindowCacheLoaded();
    expectTokens("gpt-5.5", 200_000, {
      cfg: config("openai", "gpt-5.5", 1_000_000),
      provider: "openai",
      modelContextTokens: 272_000,
      ...sync,
    });
  });

  it("uses self-prefixed provider discovery ahead of the bare cross-provider minimum", async () => {
    state.catalog.entries = [
      discovered("gemini-3.1-pro-preview", 128_000, "github-copilot"),
      discovered("gemini-3.1-pro-preview", 128_000),
      discovered("google-gemini-cli/gemini-3.1-pro-preview", 1_048_576, "google-gemini-cli"),
    ];
    await context.ensureContextWindowCacheLoaded();
    expectTokens("gemini-3.1-pro-preview", 1_048_576, { provider: "google-gemini-cli" });
    expectTokens("gemini-3.1-pro-preview", 128_000);
  });

  it("falls back to a bare configured row", () => {
    expectTokens("kilocode/kilo-auto/balanced", 900_000, {
      cfg: config("kilocode", "kilo-auto/balanced", 900_000, 900_000),
      provider: "kilocode",
    });
  });

  it("treats explicit config as authoritative for read-only misses", () => {
    state.loadConfig.mockImplementation(() => {
      throw new Error("runtime config should not load");
    });
    expectTokens("unknown-test-model", 123_000, {
      cfg: { agents: { defaults: {} } },
      provider: "openai",
      fallbackContextTokens: 123_000,
      allowAsyncLoad: false,
    });
    expect(state.loadConfig).not.toHaveBeenCalled();
  });

  it("does not confuse raw slash model ids with verified provider identity", async () => {
    state.catalog.entries = [discovered("google/gemini-2.5-pro", 999_000, "openrouter")];
    await context.ensureContextWindowCacheLoaded();
    const cfg = config("google", "gemini-2.5-pro", 2_000_000);
    expectTokens("gemini-2.5-pro", 2_000_000, { cfg, provider: "google" });
    expectTokens("google/gemini-2.5-pro", 999_000, { provider: "openrouter" });
    expectTokens("gemini-2.5-pro", undefined, { provider: "google" });
    expectTokens("google/gemini-2.5-pro", 999_000, { cfg });
  });
});
