import { beforeEach, expect, it, vi } from "vitest";
import { resolveProjectedSessionContextTokenBudget } from "../config/sessions/context-token-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createRunResult, withSession } from "./command/session-store.test-support.js";
import { prepareDiscoveredContextTokenCache } from "./context-cache-projection.js";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
  replaceDiscoveredContextTokenCache,
} from "./context-cache.js";
import { resetContextWindowCacheForTest } from "./context.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
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
    source: "resolved",
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
    source: "resolved",
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
    source: "resolved",
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
    source: "resolved",
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
            configuredContextTokenLimits: {
              effectiveConfiguredTokens: authored,
              authoredContextTokenCap: authored,
            },
          }),
        ).toEqual(
          declaredOptions && authored === undefined && runtime === undefined
            ? undefined
            : { contextTokens: expected, contextTokensSource: source },
        );
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

it.each(["selected", "default"] as const)(
  "refreshes a persisted %s option budget from changed cold catalog facts",
  async (selection) => {
    const provider = "fixture-accounting";
    const model = "changing-options";
    const catalogEntry: ModelCatalogEntry = {
      provider,
      id: model,
      name: "Changing options",
      contextWindow: 1_000_000,
      contextWindows: [
        { id: "small", label: "Small", contextWindow: 200_000 },
        { id: "wide", label: "Wide", contextWindow: 1_000_000 },
      ],
      contextWindowDefault: "small",
    };
    publish([catalogEntry]);
    await withSession(async ({ seed, update, read }) => {
      const seeded = await seed({ contextWindow: selection === "selected" ? "small" : undefined });
      const run = () =>
        update({
          defaultProvider: provider,
          defaultModel: model,
          result: createRunResult({
            sessionId: seeded.sessionId,
            provider,
            model,
            agentHarnessId: "openclaw",
          }),
        });
      await run();
      expect(read()?.contextTokens).toBe(200_000);
      expect.soft(read()?.contextTokensSource).toBe("resolved");
      facts.owner = undefined;
      resetContextWindowCacheForTest();
      const changed: ModelCatalogEntry =
        selection === "selected"
          ? {
              ...catalogEntry,
              contextWindows: [
                { id: "small", label: "Small", contextWindow: 1_000_000 },
                { id: "wide", label: "Wide", contextWindow: 1_000_000 },
              ],
            }
          : { ...catalogEntry, contextWindowDefault: "wide" };
      facts.load.mockResolvedValue({ entries: [changed], routeVariants: [changed] });
      await run();
      expect.soft(facts.load).toHaveBeenCalledOnce();
      expect(read()).toMatchObject({ contextTokens: 1_000_000, contextTokensSource: "resolved" });
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
          contextTokensSource: selected ? "resolved" : "resolved-v1",
        });
        expect(facts.load).not.toHaveBeenCalled();
      });
    } finally {
      caches.contextWindowCache.delete(key);
      caches.discoveredTokenCache.delete(key);
    }
  },
);
it.each<
  [
    name: string,
    successful: string | null,
    expected: number,
    source: "runtime" | "resolved" | "resolved-v1",
    runtime?: number,
    locked?: boolean,
    ambientOwner?: boolean,
    catalogTokens?: number,
  ]
>([
  ["matching successful account", "fixture:catalog", 777_000, "resolved-v1"],
  ["different successful account", "fixture:run", 200_000, "resolved"],
  ["matching successful runtime account", "fixture:catalog", 900_000, "runtime", 900_000],
  ["different successful runtime account", "fixture:run", 900_000, "resolved", 900_000],
  ["observed ambient runtime account", null, 900_000, "resolved", 900_000],
  ["locked native runtime account", "fixture:run", 900_000, "runtime", 900_000, true],
  ["observed ambient account without runtime capacity", null, 200_000, "resolved"],
  [
    "matching observed ambient catalog account",
    null,
    777_000,
    "resolved-v1",
    undefined,
    false,
    true,
  ],
  [
    "accepted discovery with a foreign cache",
    null,
    654_321,
    "resolved-v1",
    undefined,
    false,
    true,
    654_321,
  ],
])(
  "persists only the actual %s capacity through command accounting",
  async (
    name,
    successful,
    expected,
    source,
    runtime,
    locked = false,
    ambientOwner = false,
    catalogTokens = 777_000,
  ) => {
    const provider = "fixture-accounting";
    const model = "account-bound-model";
    replaceDiscoveredContextTokenCache(
      await prepareDiscoveredContextTokenCache({
        modelCatalog: { entries: [{ provider, id: model, contextTokens: 654_321 }] },
      }),
    );
    facts.owner = {
      isCurrent: () => true,
      modelCatalog: {
        entries: [
          {
            provider,
            id: model,
            name: "Account model",
            contextWindow: 1_000_000,
            contextTokens: catalogTokens,
          },
        ],
        providerOutcomes: [
          { provider, profileId: ambientOwner ? undefined : "fixture:catalog", status: "ready" },
        ],
      },
    };
    await withSession(async ({ seed, update, read }) => {
      const seeded = await seed({
        authProfileOverride: ambientOwner ? undefined : "fixture:catalog",
        modelProvider: provider,
        model,
        agentHarnessId: "openclaw",
        contextTokens: 888_000,
        contextTokensSource: "resolved-v1",
        modelSelectionLocked: locked,
      });
      await update({
        defaultProvider: provider,
        defaultModel: model,
        authProfileId: successful,
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
      if (name === "accepted discovery with a foreign cache") {
        resetContextWindowCacheForTest();
        expect(
          resolveProjectedSessionContextTokenBudget({
            entry: persisted,
            provider,
            model,
            agentHarnessId: "openclaw",
            resolvedContextTokens: undefined,
          }),
        ).toEqual({ contextTokens: expected, contextTokensSource: "resolved-v1" });
      }
    });
    expect(facts.load).not.toHaveBeenCalled();
  },
);
