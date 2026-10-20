import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "./context-cache.js";
import { modelConfig } from "./context-config.test-support.js";
import {
  resetContextWindowCache,
  resolveContextTokensForModel,
  resolveModelContextTokenProjection,
} from "./context.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  projectConfigOntoRuntimeSourceSnapshot: (config: unknown) => config,
}));

function resolve(params: Parameters<typeof resolveContextTokensForModel>[0]) {
  return resolveContextTokensForModel({ allowAsyncLoad: false, ...params });
}

beforeEach(resetContextWindowCacheForTest);
afterEach(resetContextWindowCacheForTest);

it("adds valid configured windows and ignores invalid entries", () => {
  const cfg = modelConfig("openrouter", "custom/model", { contextWindow: 150_000 });
  const configuredModel = cfg.models?.providers?.openrouter?.models?.[0];
  if (!configuredModel) {
    throw new Error("configured model fixture is missing");
  }
  cfg.models?.providers?.openrouter?.models?.push(
    { ...configuredModel, id: "bad/model", contextWindow: 0 },
    { ...configuredModel, id: "", contextWindow: 300_000 },
  );
  resetContextWindowCache(cfg);
  const { contextWindowCache: windowCache } = getContextWindowCaches();
  expect(windowCache.get("custom/model")).toBe(150_000);
  expect(windowCache.has("bad/model")).toBe(false);
  expect(windowCache.has("")).toBe(false);
});

it("keeps captured reporting independent of stale configured cache without changing execution lookup", () => {
  const caches = getContextWindowCaches();
  const key = providerContextTokenCacheKey("custom", "large");
  caches.configuredTokenCache.set(key, 128_000);
  const selected = {
    cfg: {},
    provider: "custom",
    model: "large",
    modelContextTokens: 922_000,
    modelContextWindow: 1_050_000,
  };
  expect(resolve(selected)).toBe(128_000);
  expect(resolve({ ...selected, allowCacheLookup: false })).toBe(922_000);
  expect(caches.configuredTokenCache.get(key)).toBe(128_000);
});

const defaults = {
  params: { context1m: true },
  models: { "claude-cli/claude-opus-4-7": { params: { context1m: false } } },
};
it.each<[string, string, OpenClawConfig | undefined, number]>([
  ["claude-cli", "claude-opus-4-7", { agents: { defaults } }, 200_000],
  ["claude-cli", "claude-sonnet-5", undefined, 1_000_000],
  ["anthropic-vertex", "claude-sonnet-4-6", undefined, 1_000_000],
])("resolves fixed or model-overridden capacity for %s/%s", (provider, model, cfg, expected) => {
  expect(resolve({ provider, model, cfg, fallbackContextTokens: 200_000 })).toBe(expected);
});

it("retains authored cap provenance when a native window lowers the effective cap", () => {
  const params = {
    cfg: modelConfig("custom", "wide", { contextWindow: 128_000, contextTokens: 1_000_000 }),
    provider: "custom",
    model: "wide",
    allowAsyncLoad: false,
  };
  expect(resolveModelContextTokenProjection(params)).toEqual({
    contextTokens: 128_000,
    authoredContextTokens: 1_000_000,
  });
  expect(resolve(params)).toBe(128_000);
});

it("uses the caller-supplied model provider for runtime aliases", () => {
  expect(
    resolve({
      cfg: modelConfig("anthropic", "custom", { contextTokens: 100_000 }),
      provider: "fixture-cli",
      modelProvider: "anthropic",
      model: "anthropic/custom",
    }),
  ).toBe(100_000);
});
