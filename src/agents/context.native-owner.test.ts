import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "./context-cache.js";
import { resolveContextTokenBudgetForModel } from "./context.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import type { SessionContextCapacityOwner } from "./session-context-capacity.js";

const facts = vi.hoisted(() => {
  const runtimeConfig: OpenClawConfig = {};
  return {
    owner: undefined as SessionContextCapacityOwner | undefined,
    load: vi.fn(),
    runtimeConfig,
  };
});
// mock-isolation: exercise cold budget orchestration against an admitted owner without discovery.
vi.mock("./prepared-model-catalog.js", () => ({
  getPreparedModelCatalogOwnerSnapshot: () => facts.owner,
  loadPreparedModelCatalogSnapshot: facts.load,
}));
// mock-isolation: Keep host configuration outside synthetic native-owner fixtures.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => facts.runtimeConfig }));

beforeEach(() => {
  resetContextWindowCacheForTest();
  facts.owner = undefined;
  facts.runtimeConfig = {};
  facts.load.mockReset();
});

function publish(entries: ModelCatalogEntry[]) {
  facts.owner = { isCurrent: () => true, modelCatalog: { entries } };
}
const request = {
  cfg: {},
  provider: "openai",
  model: "gpt-4o",
  nativeRuntime: "codex",
  allowUnscopedModelLookup: false,
};

function authoredConfig(contextTokens: number): OpenClawConfig {
  return {
    models: {
      providers: {
        [request.provider]: {
          baseUrl: "https://fixture.example.test/v1",
          models: [
            {
              id: request.model,
              name: "Configured fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              contextTokens,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

it("keeps canonical authored caps when the published-owner caller omits cfg", async () => {
  facts.runtimeConfig = authoredConfig(32_000);
  facts.owner = {
    config: facts.runtimeConfig,
    isCurrent: () => true,
    modelCatalog: {
      entries: [
        {
          provider: request.provider,
          id: request.model,
          name: request.model,
          contextWindow: 1_000_000,
        },
      ],
    },
  };
  expect(
    await resolveContextTokenBudgetForModel({
      provider: request.provider,
      model: request.model,
      allowUnscopedModelLookup: false,
    }),
  ).toMatchObject({ contextTokens: 32_000, source: "configured" });
  expect(facts.load).not.toHaveBeenCalled();
});

it.each([undefined, "synthetic"] as const)(
  "bounds an authored cap by genuine native capacity, not a %s estimate",
  async (contextWindowSource) => {
    publish([
      {
        provider: request.provider,
        id: request.model,
        name: request.model,
        nativeRuntime: request.nativeRuntime,
        contextWindow: 128_000,
        contextWindowSource,
      },
    ]);
    expect(
      await resolveContextTokenBudgetForModel({ ...request, cfg: authoredConfig(872_000) }),
    ).toMatchObject({
      contextTokens: contextWindowSource === "synthetic" ? 872_000 : 128_000,
      source: "configured",
    });
    expect(facts.load).not.toHaveBeenCalled();
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
] as const)(
  "excludes unaccepted cold starter capacity (curated=%s, supplied=%s)",
  async (curated, supplied) => {
    const row: ModelCatalogEntry = {
      provider: request.provider,
      id: request.model,
      name: request.model,
      contextWindow: 1_000_000,
      contextTokens: 872_000,
      contextCapacitySource: "unaccepted-starter",
    };
    facts.load.mockResolvedValue({
      entries: [row],
      staticEntries: curated
        ? [{ ...row, contextCapacitySource: undefined, contextTokens: 64_000 }]
        : [],
    });
    expect(
      await resolveContextTokenBudgetForModel({
        ...request,
        nativeRuntime: "openclaw",
        ...(supplied ? { modelContextWindow: 1_000_000, modelContextTokens: 872_000 } : {}),
      }),
    ).toMatchObject({
      contextTokens: curated ? 64_000 : undefined,
      source: curated ? "model" : "fallback",
    });
    expect(facts.load).toHaveBeenCalledOnce();
  },
);

it.each([
  ["model", "google-gemini-cli/model", undefined, 600_000],
  ["google-gemini-cli/model", "model", undefined, 600_000],
  ["google-gemini-cli/model", "google-gemini-cli/model", "model", 600_000],
  ["MODEL", "google-gemini-cli/model", undefined, undefined],
] as const)(
  "uses exact-first owned model identity (%s from %s)",
  async (model, id, otherId, expected) => {
    const provider = "google-gemini-cli";
    publish([
      { provider, id, name: id, contextTokens: 600_000 },
      ...(otherId ? [{ provider, id: otherId, name: otherId, contextTokens: 128_000 }] : []),
    ]);
    expect(await resolveContextTokenBudgetForModel({ cfg: {}, provider, model })).toMatchObject({
      contextTokens: expected,
    });
    expect(facts.load).not.toHaveBeenCalled();
  },
);

it.each([
  ["api-fixture", "native-fixture", "ready", 600_000],
  ["native-fixture", "foreign-native-fixture", "ready", undefined],
  ["native-fixture", "native-fixture", "unavailable", undefined],
] as const)(
  "uses selected native account evidence (API=%s, native=%s, status=%s)",
  async (apiProfile, nativeProfile, status, expected) => {
    const catalog: ModelCatalogSnapshot = {
      entries: [
        {
          provider: request.provider,
          id: request.model,
          name: request.model,
          nativeRuntime: request.nativeRuntime,
          contextTokens: 600_000,
        },
      ],
      routeVariants: [],
      providerOutcomes: [{ provider: request.provider, profileId: apiProfile, status: "ready" }],
      nativeProviderOutcomes: {
        [request.nativeRuntime]: [{ provider: request.provider, profileId: nativeProfile, status }],
      },
    };
    facts.owner = { isCurrent: () => true, modelCatalog: catalog };
    expect(
      await resolveContextTokenBudgetForModel({ ...request, profileId: "native-fixture" }),
    ).toMatchObject({ contextTokens: expected });
    expect(facts.load).not.toHaveBeenCalled();
  },
);

it("keeps unavailable native capacity unavailable instead of acquiring API facts", async () => {
  publish([{ provider: "openai", id: "gpt-4o", name: "GPT", contextWindow: 128_000 }]);
  expect(await resolveContextTokenBudgetForModel(request)).toMatchObject({
    contextTokens: undefined,
    source: "fallback",
  });
  expect(facts.load).not.toHaveBeenCalled();
});

it.each([
  "different account",
  "retired owner",
  "unbound account",
  "unbound route",
  "matching account and route",
  "rejected account with authored cap",
  "rejected account with genuine caller metadata",
  "matching account with a smaller donor cache",
] as const)("does not acquire alternate API inventory for %s", async (binding) => {
  const provider = "fixture-accounting";
  const model = "unknown-admission-model";
  const donor: ModelCatalogEntry = {
    provider,
    id: model,
    name: "Unrelated API inventory",
    api: "openai-responses",
    baseUrl: "https://other.example.test/v1",
    contextWindow: 777_000,
  };
  getContextWindowCaches().discoveredTokenCache.set(
    providerContextTokenCacheKey(provider, model),
    binding === "matching account with a smaller donor cache" ? 64_000 : 987_000,
  );
  facts.load.mockResolvedValue({ entries: [donor], routeVariants: [donor] });
  if (binding !== "unbound account" && binding !== "unbound route" && binding !== "retired owner") {
    facts.owner = {
      isCurrent: () => true,
      modelCatalog: {
        entries: [donor],
        routeVariants: [donor],
        providerOutcomes: [
          {
            provider,
            profileId:
              binding === "matching account and route" ||
              binding === "matching account with a smaller donor cache"
                ? "fixture:current"
                : "fixture:other",
            status: "ready",
          },
        ],
      },
    };
  } else if (binding === "retired owner") {
    facts.owner = { isCurrent: () => false, modelCatalog: { entries: [donor] } };
  }
  expect(
    await resolveContextTokenBudgetForModel({
      cfg:
        binding === "rejected account with authored cap"
          ? {
              models: {
                providers: {
                  [provider]: {
                    baseUrl: "https://other.example.test/v1",
                    models: [
                      {
                        id: model,
                        name: "Configured",
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        contextTokens: 32_000,
                        maxTokens: 4096,
                      },
                    ],
                  },
                },
              },
            }
          : {},
      provider,
      model,
      nativeRuntime: "openclaw",
      ...(binding === "rejected account with genuine caller metadata"
        ? { modelContextWindow: 1_000_000, modelContextTokens: 900_000 }
        : {}),
      ...(binding !== "retired owner" && binding !== "unbound route"
        ? { profileId: "fixture:current" }
        : {}),
      ...(binding === "unbound route" || binding === "matching account and route"
        ? {
            route: {
              api: "openai-responses" as const,
              baseUrl:
                binding === "matching account and route"
                  ? "https://other.example.test/v1"
                  : "https://selected.example.test/v1",
            },
          }
        : {}),
    }),
  ).toMatchObject(
    binding === "matching account and route" ||
      binding === "matching account with a smaller donor cache"
      ? { contextTokens: 777_000, source: "model" }
      : binding === "rejected account with authored cap"
        ? { contextTokens: 32_000, source: "configured" }
        : binding === "rejected account with genuine caller metadata"
          ? { contextTokens: 900_000, source: "model" }
          : { contextTokens: undefined, source: "fallback" },
  );
  expect(facts.load).not.toHaveBeenCalled();
});

it.each([
  ["cache-only estimate", undefined, undefined, 777_000, false],
  ["genuine caller cap", 96_000, undefined, 96_000, false],
  ["authored cap", undefined, 32_000, 32_000, false],
  ["runtime-config authored cap", undefined, 32_000, 32_000, true],
] as const)(
  "reconciles fresh cold catalog capacity with %s",
  async (_name, caller, authored, expected, runtimeConfig) => {
    const provider = "fixture-accounting";
    const model = "cold-cache-recovery";
    getContextWindowCaches().discoveredTokenCache.set(
      providerContextTokenCacheKey(provider, model),
      64_000,
    );
    const entry: ModelCatalogEntry = {
      provider,
      id: model,
      name: "Current catalog",
      contextWindow: 1_000_000,
      contextTokens: 777_000,
    };
    facts.load.mockResolvedValue({ entries: [entry], routeVariants: [entry] });
    const cfg =
      authored === undefined
        ? {}
        : {
            models: {
              providers: {
                [provider]: {
                  baseUrl: "https://fixture.example.test/v1",
                  models: [
                    {
                      id: model,
                      name: "Configured",
                      reasoning: false,
                      input: ["text" as const],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextTokens: authored,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
          };
    facts.runtimeConfig = cfg;
    const result = await resolveContextTokenBudgetForModel({
      ...(runtimeConfig ? {} : { cfg }),
      provider,
      model,
      nativeRuntime: "openclaw",
      ...(caller === undefined
        ? {}
        : { modelContextTokens: caller, modelContextWindow: 1_000_000 }),
    });
    expect(result).toMatchObject({
      contextTokens: expected,
      source: authored === undefined ? "model" : "configured",
    });
    expect(facts.load).toHaveBeenCalledOnce();
  },
);

it("uses the actual native prompt cap beside a synthetic native estimate", async () => {
  publish([
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      nativeRuntime: "codex",
      contextWindow: 128_000,
      contextWindowSource: "synthetic",
      contextTokens: 777_000,
    },
  ]);
  expect(await resolveContextTokenBudgetForModel(request)).toMatchObject({
    contextTokens: 777_000,
    source: "model",
  });
  expect(facts.load).not.toHaveBeenCalled();
});

it("retains synthetic-only native capacity as an estimate", async () => {
  publish([
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      nativeRuntime: "codex",
      contextWindow: 128_000,
      contextWindowSource: "synthetic",
    },
  ]);
  expect(await resolveContextTokenBudgetForModel(request)).toMatchObject({
    contextTokens: 128_000,
    source: "fallback",
    contextTokensSource: "synthetic",
  });
  expect(facts.load).not.toHaveBeenCalled();
});

it("replaces a supplied synthetic estimate with the admitted native prompt cap", async () => {
  publish([
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      nativeRuntime: "codex",
      contextWindow: 1_000_000,
      contextTokens: 777_000,
    },
  ]);
  expect(
    await resolveContextTokenBudgetForModel({
      ...request,
      modelContextWindow: 128_000,
      modelContextWindowSource: "synthetic",
    }),
  ).toMatchObject({ contextTokens: 777_000, source: "model" });
  expect(facts.load).not.toHaveBeenCalled();
});

it("does not consume native rows as cold API capacity", async () => {
  const nativeRow = {
    provider: "openai",
    id: "gpt-4o",
    name: "GPT (native)",
    nativeRuntime: "codex",
    contextWindow: 128_000,
    contextTokens: 120_000,
  };
  publish([nativeRow]);
  facts.load.mockResolvedValue({ entries: [nativeRow], routeVariants: [nativeRow] });
  expect(
    await resolveContextTokenBudgetForModel({ ...request, nativeRuntime: "openclaw" }),
  ).toMatchObject({ contextTokens: undefined, source: "fallback" });
});

it.each(["entries", "staticEntries"] as const)(
  "reads accepted API %s instead of the owner's startup estimate",
  async (inventory) => {
    const initial = {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      contextWindow: 128_000,
      contextWindowSource: "synthetic" as const,
    };
    publish([initial]);
    facts.owner!.readFullModelCatalog = () => ({
      entries: [],
      [inventory]: [
        {
          ...initial,
          contextWindow: 1_000_000,
          contextWindowSource: undefined,
          contextTokens: 777_000,
        },
      ],
    });
    expect(
      await resolveContextTokenBudgetForModel({ ...request, nativeRuntime: "openclaw" }),
    ).toMatchObject({ contextTokens: 777_000, source: "model" });
    expect(facts.load).not.toHaveBeenCalled();
  },
);

it.each([
  [undefined, undefined],
  [{ api: "openai-responses" as const, baseUrl: "https://native.example/large" }, 777_000],
])("keeps native capacity bound to the actual route %j", async (route, contextTokens) => {
  publish([
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      nativeRuntime: "codex",
      api: "openai-responses",
      baseUrl: "https://native.example/large",
      contextWindow: 1_000_000,
      contextTokens: 777_000,
    },
    {
      provider: "openai",
      id: "gpt-4o",
      name: "GPT",
      nativeRuntime: "codex",
      api: "openai-responses",
      baseUrl: "https://native.example/small",
      contextWindow: 64_000,
    },
  ]);
  expect(await resolveContextTokenBudgetForModel({ ...request, route })).toMatchObject({
    contextTokens,
    source: contextTokens === undefined ? "fallback" : "model",
  });
  expect(facts.load).not.toHaveBeenCalled();
});
