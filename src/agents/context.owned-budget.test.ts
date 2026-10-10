import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextWindowCatalog } from "./context-cache-projection.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";
import { modelCatalogRouteVariantKey } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelCatalogIdentityKeyResolver } from "./openai-model-routes.js";
import { prepareModelCatalogPublication } from "./prepared-model-runtime.catalog-publication.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";

const state = vi.hoisted(() => {
  const initialConfig: OpenClawConfig = {};
  const catalog: ContextWindowCatalog = { entries: [], staticEntries: [] };
  const publishedOwner = vi.fn<
    (_params: unknown) =>
      | {
          config: OpenClawConfig;
          modelCatalog: ContextWindowCatalog;
          isCurrent: () => boolean;
          readFullModelCatalog?: () => ContextWindowCatalog;
        }
      | undefined
  >();
  return {
    config: initialConfig,
    catalog,
    loadConfig: vi.fn<() => OpenClawConfig>(),
    loadOwner: vi.fn<(_params: unknown) => Promise<{ modelCatalog: ContextWindowCatalog }>>(),
    publishedOwner,
    exactOwner: vi.fn<(_params: unknown) => ReturnType<typeof publishedOwner>>(),
  };
});

// mock-isolation: Capacity cases use the supplied config fixture without reading the host config.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: state.loadConfig }));
// mock-isolation: Fixtures are authored source values; live runtime snapshots must not alter them.
vi.mock("../config/runtime-source-projection.js", () => ({
  projectConfigOntoRuntimeSourceSnapshot: (snapshot: OpenClawConfig) => snapshot,
}));
// mock-isolation: Read only the admitted owner fixture; catalog acquisition and host state stay outside these cache projections.
vi.mock("./prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogOwnerSnapshot: state.loadOwner,
  getPublishedPreparedModelCatalogOwnerSnapshot: state.publishedOwner,
  getPreparedModelCatalogOwnerSnapshot: state.exactOwner,
  loadPreparedModelCatalogSnapshot: async (params: unknown) =>
    (await state.loadOwner(params)).modelCatalog,
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
    isCurrent: () => true,
    modelCatalog: state.catalog,
  }));
  state.exactOwner.mockReset().mockImplementation((params) => state.publishedOwner(params));
  resetContextWindowCacheForTest();
});

afterEach(() => {
  resetContextWindowCacheForTest();
});

describe("owned budget publication authority", () => {
  it.each([false, true])(
    "keeps accounting on its producing configuration (owner matches=%s)",
    async (matches) => {
      const previous: OpenClawConfig = {
        models: { providers: { fixture: { baseUrl: "https://previous.example/v1", models: [] } } },
      };
      const replacement: OpenClawConfig = {
        models: {
          providers: { fixture: { baseUrl: "https://replacement.example/v1", models: [] } },
        },
      };
      const catalog: ModelCatalogSnapshot = {
        entries: [
          { provider: "fixture", id: "new-model", name: "New model", contextTokens: 872_000 },
        ],
        routeVariants: [],
        staticEntries: [],
        providerOutcomes: [{ provider: "fixture", profileId: "profile-a", status: "ready" }],
      };
      const owner = { config: replacement, modelCatalog: catalog, isCurrent: () => true };
      // The published reader follows the replacement; the exact reader rejects the old config.
      state.publishedOwner.mockReturnValue(owner);
      state.exactOwner.mockReturnValue(matches ? owner : undefined);
      const projection = await context.resolveContextTokenBudgetForModel({
        cfg: matches ? replacement : previous,
        provider: "fixture",
        model: "new-model",
        profileId: "profile-a",
        modelContextWindow: 128_000,
        modelContextWindowSource: "synthetic",
      });
      expect(projection.contextTokens).toBe(matches ? 872_000 : 128_000);
      expect(projection.source).toBe(matches ? "model" : "fallback");
      expect(projection.contextTokensSource).toBe(matches ? undefined : "synthetic");
    },
  );

  it.each([
    { owner: "missing", expected: 128_000 },
    { owner: "current", expected: 872_000 },
    { owner: "foreign-route", expected: 128_000 },
    { owner: "stale", expected: 128_000 },
    { owner: "missing", cap: 64_000, expected: 64_000 },
  ] as const)(
    "keeps an owned budget separate from the provider cache ($owner, cap=$cap)",
    async ({ owner, expected, ...control }) => {
      const catalog: ModelCatalogSnapshot = {
        entries: [
          {
            name: "New model",
            provider: "fixture",
            id: "new-model",
            api: "openai-responses",
            baseUrl: "https://account.example/v1",
            contextWindow: 1_000_000,
            contextTokens: 872_000,
          },
        ],
        routeVariants: [],
        staticEntries: [],
      };
      state.catalog = catalog;
      await context.ensureContextWindowCacheLoaded({});
      expect(context.lookupContextTokens("new-model", { allowAsyncLoad: false })).toBe(872_000);
      state.catalog = { entries: [], staticEntries: [] };
      state.publishedOwner.mockReturnValue(
        owner === "missing"
          ? undefined
          : { config: {}, modelCatalog: catalog, isCurrent: () => owner !== "stale" },
      );
      const cap = "cap" in control ? control.cap : undefined;
      const projection = await context.resolveContextTokenBudgetForModel({
        cfg: cap === undefined ? {} : config("fixture", model("new-model", 1_000_000, cap)),
        provider: "fixture",
        model: "new-model",
        modelContextWindow: 128_000,
        modelContextWindowSource: "synthetic",
        ...(owner === "foreign-route"
          ? { route: { api: "openai-responses", baseUrl: "https://other.example/v1" } }
          : {}),
      });
      expect(projection.contextTokens).toBe(expected);
    },
  );

  it.each<{
    retained: boolean;
    profileId?: string;
    cap?: number;
    expected?: number;
    staticWindow?: number;
    nativeRuntime?: string;
  }>([
    { retained: false, profileId: undefined, cap: undefined, expected: 128_000 },
    { retained: false, profileId: "a", cap: undefined, expected: undefined },
    { retained: false, profileId: undefined, cap: 64_000, expected: 64_000 },
    { retained: true, profileId: undefined, cap: undefined, expected: 872_000 },
    { retained: false, staticWindow: 96_000, expected: 96_000 },
    { retained: false, staticWindow: 64_000, nativeRuntime: "codex", expected: 64_000 },
  ])(
    "sizes selected starter metadata from publication authority (retained=$retained, profile=$profileId, cap=$cap)",
    async ({ retained, profileId, cap, expected, staticWindow, nativeRuntime }) => {
      const row = {
        id: "new-model",
        name: "New model",
        provider: "fixture",
        api: "openai-responses" as const,
        baseUrl: "https://account.example/v1",
        contextWindow: 1_000_000,
        contextTokens: 872_000,
      };
      const auth = {
        authStore: { version: 1 as const, profiles: {} },
        authModes: {},
        providerAuthLabels: new Map(),
        credentials: { fixture: { type: "api_key" as const, key: "account-a" } },
      };
      const accepted = prepareModelCatalogPublication(
        { entries: [row], routeVariants: [row] },
        new Map(),
        undefined,
        auth,
        (provider) => provider,
        new Map([
          [
            "fixture",
            new Set([
              modelCatalogRouteVariantKey(row, createModelCatalogIdentityKeyResolver()(row)),
            ]),
          ],
        ]),
      );
      const failed = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          staticEntries: [row],
          providerOutcomes: [{ provider: "fixture", status: "unavailable" }],
        },
        new Map(),
        retained
          ? {
              ...accepted,
              providers: new Map([
                [
                  "fixture",
                  {
                    source: "fixture",
                    credentials: "account-a",
                    legacyRows: accepted.legacyRows.get("fixture"),
                  },
                ],
              ]),
            }
          : undefined,
        auth,
        (provider) => provider,
        new Map(),
      );
      expect(failed.discoveryOrigins).toEqual([]);
      const staticEntry = {
        ...row,
        nativeRuntime,
        contextWindow: staticWindow ?? 128_000,
        contextTokens: undefined,
        contextWindowSource: staticWindow === undefined ? ("synthetic" as const) : undefined,
      };
      const catalog = materializePreparedModelCatalog(failed.catalog, [], [staticEntry], new Set());
      expect(catalog.staticEntries).toContainEqual(staticEntry);
      state.publishedOwner.mockReturnValue({
        config: {},
        modelCatalog: catalog,
        isCurrent: () => true,
      });
      const selected = expectDefined(
        nativeRuntime ? staticEntry : catalog.entries[0],
        "Expected the selected catalog entry",
      );
      const projection = await context.resolveContextTokenBudgetForModel({
        cfg: cap === undefined ? {} : config("fixture", model("new-model", 1_000_000, cap)),
        provider: "fixture",
        model: "new-model",
        route: selected,
        nativeRuntime,
        profileId,
        modelContextWindow: selected.contextWindow,
        modelContextTokens: selected.contextTokens,
      });
      expect(projection.contextTokens).toBe(expected);
    },
  );
});
