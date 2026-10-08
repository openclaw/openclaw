import { beforeEach, expect, it, vi } from "vitest";
import { resolveProjectedSessionContextTokenBudget } from "../config/sessions/context-token-provenance.js";
import { createRunResult, withSession } from "./command/session-store.test-support.js";
import { getContextWindowCaches, providerContextTokenCacheKey } from "./context-cache.js";
import { resolveContextTokenBudgetForModel } from "./context.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import {
  createSessionContextCapacityResolver,
  type SessionContextCapacityOwner,
} from "./session-context-capacity.js";

const facts = vi.hoisted(() => ({
  owner: undefined as SessionContextCapacityOwner | undefined,
  load: vi.fn(),
}));
// mock-isolation: exercise cold budget orchestration against an admitted owner without discovery.
vi.mock("./prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => facts.owner,
  loadPreparedModelCatalogSnapshot: facts.load,
}));
// mock-isolation: Keep host configuration outside synthetic native-owner fixtures.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));

beforeEach(() => {
  resetContextWindowCacheForTest();
  facts.owner = undefined;
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
  facts.load.mockResolvedValue({ entries: [donor], routeVariants: [donor] });
  if (binding === "different account" || binding === "matching account and route") {
    facts.owner = {
      isCurrent: () => true,
      modelCatalog: {
        entries: [donor],
        routeVariants: [donor],
        providerOutcomes: [
          {
            provider,
            profileId: binding === "different account" ? "fixture:other" : "fixture:current",
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
      cfg: {},
      provider,
      model,
      nativeRuntime: "openclaw",
      ...(binding === "different account" ||
      binding === "unbound account" ||
      binding === "matching account and route"
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
    binding === "matching account and route"
      ? { contextTokens: 777_000, source: "model" }
      : { contextTokens: undefined, source: "fallback" },
  );
  expect(facts.load).not.toHaveBeenCalled();
});

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

it.each([
  {
    name: "synthetic estimate",
    contextWindowSource: "synthetic" as const,
    contextTokensSource: "synthetic" as const,
  },
  {
    name: "reported native window",
    contextWindowSource: undefined,
    contextTokensSource: "resolved-v1" as const,
  },
])(
  "retains $name provenance through actual accounting and cold projection",
  async ({ contextWindowSource, contextTokensSource }) => {
    publish([
      {
        provider: request.provider,
        id: request.model,
        name: "GPT",
        nativeRuntime: request.nativeRuntime,
        contextWindow: 128_000,
        contextWindowSource,
      },
    ]);
    await withSession(async ({ seed, update, read }) => {
      const seeded = await seed({ agentHarnessId: request.nativeRuntime });
      await update({
        defaultProvider: request.provider,
        defaultModel: request.model,
        result: createRunResult({
          sessionId: seeded.sessionId,
          provider: request.provider,
          model: request.model,
          agentHarnessId: request.nativeRuntime,
        }),
      });
      const persisted = read();
      expect(persisted).toMatchObject({ contextTokens: 128_000, contextTokensSource });
      resetContextWindowCacheForTest();
      const selection = {
        entry: persisted,
        provider: request.provider,
        model: request.model,
        agentHarnessId: request.nativeRuntime,
        resolvedContextTokens: undefined,
      };
      expect(
        resolveProjectedSessionContextTokenBudget({
          ...selection,
          ownerCapacity: createSessionContextCapacityResolver(facts.owner)(
            request.provider,
            request.model,
            { nativeRuntime: request.nativeRuntime },
          ),
        }),
      ).toEqual({ contextTokens: 128_000, contextTokensSource });
      if (contextWindowSource === "synthetic") {
        expect(
          resolveProjectedSessionContextTokenBudget({
            ...selection,
            ownerCapacity: { state: "unavailable" },
          }),
        ).toBeUndefined();
      }
    });
  },
);

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

it.each([
  {
    name: "selected",
    cold: false,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: "small",
    authored: undefined,
    runtime: undefined,
    expected: 200_000,
    source: "resolved-v1",
  },
  {
    name: "declared default",
    cold: false,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: undefined,
    authored: undefined,
    runtime: undefined,
    expected: 200_000,
    source: "resolved-v1",
  },
  {
    name: "authored prompt bound",
    cold: false,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: "small",
    authored: 64_000,
    runtime: undefined,
    expected: 64_000,
    source: "resolved",
  },
  {
    name: "reported runtime",
    cold: false,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: "small",
    authored: undefined,
    runtime: 128_000,
    expected: 128_000,
    source: "runtime",
  },
  {
    name: "cold selected",
    cold: true,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: "small",
    authored: undefined,
    runtime: undefined,
    expected: 200_000,
    source: "resolved-v1",
  },
  {
    name: "cold declared default",
    cold: true,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 200_000,
    selected: undefined,
    authored: undefined,
    runtime: undefined,
    expected: 200_000,
    source: "resolved-v1",
  },
  {
    name: "cold authored prompt below fixed model but above declared default",
    cold: true,
    prompt: undefined,
    declaredOptions: true,
    smallWindow: 32_000,
    selected: undefined,
    authored: 64_000,
    runtime: undefined,
    expected: 32_000,
    source: "resolved",
  },
  {
    name: "cold reported prompt without declared options",
    cold: true,
    prompt: 64_000,
    declaredOptions: false,
    smallWindow: 1_000_000,
    selected: undefined,
    authored: undefined,
    runtime: undefined,
    expected: 64_000,
    source: "resolved-v1",
  },
  {
    name: "cold fixed reported prompt beside an unselected scalar window",
    cold: true,
    prompt: 1_000_000,
    declaredOptions: false,
    smallWindow: 128_000,
    selected: undefined,
    authored: undefined,
    runtime: undefined,
    expected: 1_000_000,
    source: "resolved-v1",
  },
  {
    name: "cold scalar window only beside fixed contract",
    cold: true,
    prompt: undefined,
    declaredOptions: false,
    smallWindow: 128_000,
    selected: undefined,
    authored: undefined,
    runtime: undefined,
    expected: 1_000_000,
    source: "resolved-v1",
  },
])(
  "persists $name capacity before promoting a known scalar budget",
  async ({
    cold,
    prompt,
    declaredOptions,
    smallWindow,
    selected,
    authored,
    runtime,
    expected,
    source,
  }) => {
    const provider = "anthropic",
      model = "claude-opus-5";
    const catalogEntry: ModelCatalogEntry = {
      provider,
      id: model,
      name: "Opus",
      contextWindow: declaredOptions ? 1_000_000 : smallWindow,
      ...(prompt === undefined ? {} : { contextTokens: prompt }),
      ...(declaredOptions
        ? {
            contextWindows: [
              { id: "small", label: "Small", contextWindow: smallWindow },
              { id: "wide", label: "Wide", contextWindow: 1_000_000 },
            ],
            contextWindowDefault: "small",
          }
        : {}),
    };
    if (cold) {
      facts.load.mockResolvedValue({ entries: [catalogEntry], routeVariants: [catalogEntry] });
    } else {
      publish([catalogEntry]);
    }
    await withSession(async ({ seed, update, read }) => {
      const seeded = await seed({
        contextWindow: selected,
        agentHarnessId: "previous-native-runtime",
      });
      await update({
        cfg:
          authored === undefined
            ? {}
            : {
                models: {
                  providers: {
                    anthropic: {
                      baseUrl: "https://api.anthropic.com",
                      models: [
                        {
                          id: model,
                          name: "Opus",
                          contextTokens: authored,
                          reasoning: false,
                          input: ["text"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          maxTokens: 4096,
                        },
                      ],
                    },
                  },
                },
              },
        defaultProvider: provider,
        defaultModel: model,
        result: createRunResult({
          sessionId: seeded.sessionId,
          provider,
          model,
          agentHarnessId: "openclaw",
          contextTokens: runtime,
        }),
      });
      const persisted = read();
      expect(persisted).toMatchObject({ contextTokens: expected, contextTokensSource: source });
      if (!cold || authored === undefined) {
        resetContextWindowCacheForTest();
        expect(
          resolveProjectedSessionContextTokenBudget({
            entry: persisted,
            provider,
            model,
            agentHarnessId: "openclaw",
            resolvedContextTokens: undefined,
            authoredContextTokens: authored,
          }),
        ).toEqual({ contextTokens: expected, contextTokensSource: source });
      }
      if (cold) {
        if (declaredOptions || prompt !== undefined) {
          expect(facts.load).toHaveBeenCalledOnce();
        }
      } else {
        expect(facts.load).not.toHaveBeenCalled();
      }
    });
  },
);

it("retains an exact saved budget without acquiring a cold API catalog", async () => {
  const provider = "fixture-accounting",
    model = "unknown-model";
  await withSession(async ({ seed, update, read }) => {
    const seeded = await seed({
      modelProvider: provider,
      model,
      agentHarnessId: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "resolved-v1",
    });
    await update({
      defaultProvider: provider,
      defaultModel: model,
      result: createRunResult({
        sessionId: seeded.sessionId,
        provider,
        model,
        agentHarnessId: "openclaw",
      }),
    });
    expect(read()).toMatchObject({ contextTokens: 272_000, contextTokensSource: "resolved-v1" });
    expect(facts.load).not.toHaveBeenCalled();
  });
});

it.each([
  {
    name: "reported prompt below selected window",
    provider: "fixture-accounting",
    model: "warm-selected",
    prompt: 128_000,
    selected: "small",
    window: 1_000_000,
    windowSource: undefined,
    expected: 128_000,
  },
  {
    name: "reported prompt without declared options",
    provider: "fixture-accounting",
    model: "warm-prompt",
    prompt: 917_504,
    selected: undefined,
    window: 1_000_000,
    windowSource: undefined,
    expected: 917_504,
  },
  {
    name: "genuine scalar window without reported prompt",
    provider: "fixture-accounting",
    model: "warm-scalar",
    prompt: undefined,
    selected: undefined,
    window: 64_000,
    windowSource: undefined,
    expected: 64_000,
  },
  {
    name: "fixed contract beside a scalar window only",
    provider: "anthropic",
    model: "claude-opus-5",
    prompt: undefined,
    selected: undefined,
    window: 128_000,
    windowSource: undefined,
    expected: 1_000_000,
  },
  {
    name: "fixed reported prompt beside an unselected scalar window",
    provider: "anthropic",
    model: "claude-opus-5",
    prompt: 1_000_000,
    selected: undefined,
    window: 128_000,
    windowSource: undefined,
    expected: 1_000_000,
  },
  {
    name: "fixed smaller reported prompt beside an unselected scalar window",
    provider: "anthropic",
    model: "claude-opus-5",
    prompt: 64_000,
    selected: undefined,
    window: 128_000,
    windowSource: undefined,
    expected: 64_000,
  },
  {
    name: "fixed reported prompt with a declared selected window",
    provider: "anthropic",
    model: "claude-opus-5",
    prompt: 1_000_000,
    selected: "small",
    window: 128_000,
    windowSource: undefined,
    expected: 200_000,
  },
  {
    name: "genuine native window below reported prompt",
    provider: "fixture-accounting",
    model: "warm-native",
    prompt: 777_000,
    selected: undefined,
    window: 128_000,
    windowSource: undefined,
    expected: 128_000,
  },
  {
    name: "synthetic native window beside reported prompt",
    provider: "fixture-accounting",
    model: "warm-synthetic",
    prompt: 777_000,
    selected: undefined,
    window: 128_000,
    windowSource: "synthetic" as const,
    expected: 777_000,
  },
])(
  "persists $name from current owner facts instead of a warm scalar",
  async ({ provider, model, prompt, selected, window, windowSource, expected }) => {
    publish([
      {
        provider,
        id: model,
        name: "Accounting fixture",
        contextWindow: window,
        contextWindowSource: windowSource,
        contextTokens: prompt,
        ...(selected
          ? { contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }] }
          : {}),
      },
    ]);
    const caches = getContextWindowCaches();
    const key = providerContextTokenCacheKey(provider, model);
    caches.contextWindowCache.set(key, 1_000_000);
    caches.discoveredTokenCache.set(key, 1_000_000);
    try {
      await withSession(async ({ seed, update, read }) => {
        const seeded = await seed({
          contextWindow: selected,
          agentHarnessId: "previous-native-runtime",
        });
        await update({
          defaultProvider: provider,
          defaultModel: model,
          result: createRunResult({
            sessionId: seeded.sessionId,
            provider,
            model,
            agentHarnessId: "openclaw",
          }),
        });
        expect(read()).toMatchObject({
          contextTokens: expected,
          contextTokensSource: "resolved-v1",
        });
        expect(facts.load).not.toHaveBeenCalled();
      });
    } finally {
      caches.contextWindowCache.delete(key);
      caches.discoveredTokenCache.delete(key);
    }
  },
);
