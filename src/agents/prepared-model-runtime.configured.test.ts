import { describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveEmbeddedRuntimeModelPolicy } from "./embedded-agent-runner/run/setup.js";
import { modelDefinition } from "./model-auth.fixtures.test-support.js";
import { providerConfig } from "./model-catalog-fixtures.test-support.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { prepareModelCatalogPublication } from "./prepared-model-runtime.catalog-publication.js";
import { prepareCapturedRuntimeFacts } from "./prepared-model-runtime.configured-catalog.js";
import {
  collectPreparedModelRuntimeConfiguredRefs as collectRefs,
  collectPreparedModelRuntimeProviderIds as providerIds,
} from "./prepared-model-runtime.configured.js";
import { materializePreparedModelCatalog } from "./prepared-model-runtime.full-catalog.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";

const harness = (id: string) => ({ agentRuntime: { id } });
const runtimeIds = ["fixture", "fixture-harness"];
const modelProvider = (fields: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  baseUrl: "https://fixture.invalid/v1",
  models: [],
  ...fields,
});

it("keeps credential-only providers out of static catalog preparation", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        inline: modelProvider({ apiKey: "fixture-key" }),
        referenced: modelProvider({ apiKey: { source: "file", provider: "fixture", id: "key" } }),
        blank: modelProvider({ apiKey: " " }),
        unrelated: modelProvider(),
      },
    },
  };
  expect(providerIds(config, {}, false, [])).toEqual([]);
  expect(providerIds(config, {}, true, [])).toEqual(["inline", "referenced"]);
});

it("prepares scoped refs and literal selections without changing config or Decision identity", () => {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        model: "fixture/model",
        models: {
          "fixture/Reader": harness("openclaw"),
          "fixture/Reader@variant": harness("fixture-harness"),
        },
      },
      entries: {
        worker: {
          decisionModel: "fixture/decision@20261018@iq4_xs@fixture:key",
          models: { "fixture/literal@variant": {} },
        },
        other: { decisionModel: "other/model" },
      },
    },
    channels: { modelByChannel: { fixture: { decisionModel: "fixture/channel@profile" } } },
  };
  const before = structuredClone(config);
  const selections = Object.freeze([
    Object.freeze({ provider: "fixture", modelId: "Reader@variant" }),
    Object.freeze({ provider: "fixture", modelId: "reader@variant" }),
  ]);
  const refs = collectRefs(config, "worker", selections);
  expect(refs.map(({ value }) => value)).toEqual([
    "fixture/model",
    "fixture/Reader",
    "fixture/Reader@variant",
    "fixture/decision@20261018@iq4_xs",
    "fixture/literal@variant",
    "fixture/channel@profile",
    "fixture/Reader@variant",
    "fixture/reader@variant",
  ]);
  const withProvider = {
    ...config,
    ...providerConfig("fixture", modelProvider(harness("fixture-harness"))),
  };
  const decisions = refs.filter((ref) => ref.capability === "decision");
  expect(providerIds(withProvider, {}, false, decisions)).toEqual(["fixture"]);
  expect(providerIds(withProvider, {}, false, refs.slice(0, 1))).toEqual(runtimeIds);
  expect(refs.slice(-2).map(({ kind }) => kind)).toEqual(["literal", "literal"]);
  expect(providerIds(config, {}, false, refs.slice(-2), "worker")).toEqual(runtimeIds);
  expect(config).toEqual(before);
});

describe("configured catalog authority", () => {
  function captureRegistry(
    registry: ModelRegistry,
    config: OpenClawConfig,
    pluginMetadataSnapshot: PluginMetadataSnapshot,
  ) {
    return prepareCapturedRuntimeFacts({
      agentFacts: { input: { config }, configuredModelRefs: [] },
      workspaceFacts: { pluginMetadataSnapshot },
      templateModelRegistry: registry,
      configuredRuntimeModels: [],
    });
  }
  it.each([undefined, "merge", "replace"] as const)(
    "preserves alias rows and reads captured inventory once when needed (mode %s)",
    (mode) => {
      const alias = "fixture-alias";
      const baseUrl = "https://fixture.invalid/v1";
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "fixture",
            providers: ["fixture"],
            modelCatalog: { aliases: { [alias]: { provider: "fixture" } } },
          },
        ],
      });
      const config: OpenClawConfig = {
        models: {
          mode,
          providers: {
            [alias]: { api: "openai-responses", baseUrl, models: [modelDefinition("model")] },
          },
        },
      };
      const registry = ModelRegistry.inMemory(AuthStorage.inMemory({}));
      const window = { id: "long", label: "Long", contextWindow: 128_000 };
      const captured = {
        id: "model",
        reasoning: false,
        maxTokens: 256,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        provider: alias,
        api: "openai-responses" as const,
        name: "Captured",
        baseUrl,
        input: ["text" as const],
        contextWindow: 128_000,
        contextWindows: [window],
      };
      const getAll = vi.spyOn(registry, "getAll").mockReturnValue([captured]);
      const { modelCatalog } = captureRegistry(registry, config, metadata);
      expect(getAll).toHaveBeenCalledTimes(mode === "replace" ? 0 : 1);
      expect(modelCatalog.routeVariants).toBe(modelCatalog.entries);
      expect(modelCatalog.entries.map(({ provider, name }) => [provider, name])).toEqual(
        mode === "replace"
          ? [[alias, "model"]]
          : [
              [alias, "model"],
              ["fixture", "Captured"],
            ],
      );
      expect(captured.provider).toBe(alias);
      if (mode !== "replace") {
        const [configured, canonical] = modelCatalog.entries;
        expect(configured!.contextWindows).toEqual([window]);
        expect(canonical!.contextWindows).toEqual([window]);
        expect(configured!.contextWindows![0]).not.toBe(canonical!.contextWindows![0]);
        expect(canonical!.contextWindows![0]).not.toBe(window);
      }
    },
  );
  const fallback = {
    provider: "fixture",
    id: "new-model",
    name: "New model",
    api: "openai-responses" as const,
    contextWindow: 128_000,
    // Only the provider's unknown-model fallback opts into replacement.
    contextWindowSource: "synthetic" as const,
  };
  const discovered = {
    provider: "fixture",
    id: "new-model",
    name: "New model",
    api: "openai-responses" as const,
    baseUrl: "https://account.example/v1",
    contextWindow: 1_000_000,
    contextTokens: 872_000,
  };
  const auth = (account: string) => ({
    authStore: { version: 1 as const, profiles: {} },
    authModes: {},
    providerAuthLabels: new Map(),
    credentials: { fixture: { type: "api_key" as const, key: account } },
  });
  function budget(
    entries: ModelCatalogEntry[] = [discovered],
    staticEntry: ModelCatalogEntry = fallback,
    config: OpenClawConfig = {},
  ) {
    const publication = prepareModelCatalogPublication(
      {
        entries,
        routeVariants: entries,
        providerOutcomes: [{ provider: "fixture", status: "ready" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
    );
    const catalog = materializePreparedModelCatalog(
      publication.catalog,
      [],
      [staticEntry],
      new Set(publication.discoveryOrigins.map(({ provider }) => provider)),
    );
    const selected =
      catalog.staticEntries?.find(
        (entry) => entry.provider === "fixture" && entry.id === "new-model",
      ) ??
      catalog.entries.find((entry) => entry.provider === "fixture" && entry.id === "new-model");
    expect(selected).toBeDefined();
    return resolveEmbeddedRuntimeModelPolicy({
      cfg: config,
      provider: "fixture",
      modelId: "new-model",
      nativeModelOwned: false,
      runtimeModel: {
        id: "new-model",
        name: "New model",
        api: "openai-responses",
        provider: "fixture",
        baseUrl: discovered.baseUrl,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        maxTokens: 4096,
        ...selected,
        input: ["text"],
      },
    }).contextTokenBudget;
  }
  it("uses accepted account prompt limits instead of the superseded synthetic window", () => {
    expect(budget()).toBe(872_000);
  });
  it("preserves explicit authored prompt and native-window caps", () => {
    for (const limits of [{ contextTokens: 64_000 }, { contextWindow: 64_000 }]) {
      const config: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              baseUrl: discovered.baseUrl,
              models: [
                modelDefinition("new-model", {
                  name: "New model",
                  reasoning: false,
                  contextWindow: discovered.contextWindow,
                  maxTokens: 4096,
                  ...limits,
                }),
              ],
            },
          },
        },
      };
      expect(budget([discovered], fallback, config)).toBe(64_000);
    }
  });
  it("retains only same-account inventory after failure", () => {
    const accepted = prepareModelCatalogPublication(
      {
        entries: [discovered],
        routeVariants: [],
        providerOutcomes: [{ provider: "fixture", status: "ready", profileId: "a" }],
      },
      new Map(),
      undefined,
      auth("account-a"),
      (provider) => provider,
    );
    for (const account of ["account-a", "account-b"]) {
      const failed = prepareModelCatalogPublication(
        {
          entries: [],
          routeVariants: [],
          providerOutcomes: [{ provider: "fixture", status: "unavailable", profileId: "a" }],
        },
        new Map(),
        { ...accepted, providers: new Map() },
        auth(account),
        (provider) => provider,
      );
      const catalog = materializePreparedModelCatalog(
        failed.catalog,
        [],
        [fallback],
        new Set(failed.discoveryOrigins.map(({ provider }) => provider)),
      );
      if (account === "account-a") {
        expect(catalog.entries).toContainEqual(discovered);
        expect(catalog.staticEntries).not.toContainEqual(fallback);
        expect(failed.discoveryOrigins).toEqual(accepted.discoveryOrigins);
      } else {
        expect(catalog.entries).not.toContainEqual(discovered);
        expect(catalog.staticEntries).toContainEqual(fallback);
        expect(failed.discoveryOrigins).toEqual([]);
      }
    }
  });
  it("keeps declared inference bound to the configured physical route (custom endpoint)", () => {
    const custom = true;
    const chat = false;
    const inference = {
      chat,
      decision: { protocol: "fixture", input: ["text" as const] },
    };
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "fixture",
          providers: ["fixture"],
          modelCatalog: {
            providers: {
              fixture: {
                api: "openai-responses",
                baseUrl: "https://catalog.fixture.invalid/v1",
                models: [{ id: "typed", name: "Typed", inference }],
              },
            },
          },
        },
      ],
    });
    const config: OpenClawConfig = {
      models: {
        providers: {
          fixture: {
            api: "openai-responses",
            baseUrl: "https://catalog.fixture.invalid/v1",
            models: [
              modelDefinition("typed", {
                name: "Configured",
                ...(custom ? { baseUrl: "https://custom.fixture.invalid/v1" } : {}),
                reasoning: false,
                maxTokens: 256,
              }),
            ],
          },
        },
      },
    };
    const registry = ModelRegistry.create(AuthStorage.inMemory({}), "captured:typed-configured", {
      config,
      includePluginCatalogs: false,
      pluginMetadataSnapshot: metadata,
    });
    const facts = captureRegistry(registry, config, metadata);
    const rows = facts.modelCatalog.entries.filter(
      (entry) => entry.provider === "fixture" && entry.id === "typed",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "Configured",
      baseUrl: custom ? "https://custom.fixture.invalid/v1" : "https://catalog.fixture.invalid/v1",
      inference: custom ? { chat: false } : inference,
    });
    if (custom) {
      expect(rows[0]!.inference).not.toHaveProperty("decision");
    }
  });
});
