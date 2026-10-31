import { normalizeModelCatalogProviderRows } from "@openclaw/model-catalog-core/model-catalog-normalize";
import type {
  ModelCatalog,
  ModelCatalogModel,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { planEffectiveModelCatalogRows } from "../model-catalog/index.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import { modelDefinition as configuredModel } from "./model-auth.fixtures.test-support.js";
import { enrichHarnessRows, modelCatalogRowToEntry } from "./model-catalog-entry.js";
import { row } from "./model-catalog-fixtures.test-support.js";
import { overlayCatalogMetadata } from "./model-catalog-metadata.js";
import {
  buildPreparedModelCatalogSnapshot,
  type BuildPreparedModelCatalogParams,
  findModelCatalogEntry,
  loadManifestModelCatalog,
  modelSupportsVision,
  overlayConfiguredModelCatalog,
} from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import { ModelRegistry } from "./sessions/model-registry.js";

type AugmentModelCatalogWithProviderPlugins =
  typeof import("../plugins/provider-runtime.js").augmentModelCatalogWithProviderPlugins;

const mocks = vi.hoisted(() => ({
  augmentModelCatalogWithProviderPlugins: vi.fn<AugmentModelCatalogWithProviderPlugins>(
    async () => [],
  ),
}));

// mock-isolation: catalog tests supply provider metadata without loading provider runtimes.
vi.mock("../plugins/provider-runtime.runtime.js", () => mocks);
vi.mock("../model-catalog/index.js", { spy: true });
vi.mock("@openclaw/model-catalog-core/model-catalog-normalize", { spy: true });

const metadataSnapshot = createPluginMetadataSnapshotFixture();

function createManifestSnapshot(provider: string, modelCatalog: ModelCatalog) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: provider, origin: "bundled", providers: [provider], modelCatalog }],
  });
}

function providerManifestSnapshot(
  provider: string,
  discovery: "static" | "refreshable" | "runtime",
  modelIds: string[],
  aliases: string[] = [],
): PluginMetadataSnapshot {
  const models = modelIds.map((id) => ({ id, name: id }));
  return createManifestSnapshot(provider, {
    aliases: Object.fromEntries(aliases.map((alias) => [alias, { provider }])),
    providers: { [provider]: { api: "openai-responses", models } },
    discovery: { [provider]: discovery },
  });
}

function providerConfig(provider: string, entry: ModelProviderConfig): OpenClawConfig {
  return { plugins: { enabled: false }, models: { providers: { [provider]: entry } } };
}

const fableWindows = () => [
  { id: "200k", label: "200K", contextWindow: 200_000 },
  { id: "1m", label: "1M", contextWindow: 1_000_000 },
];
function fableManifest(extra: Partial<ModelCatalogModel> = {}) {
  const model: ModelCatalogModel = {
    id: "claude-fable-5",
    contextWindow: 1_000_000,
    contextWindows: fableWindows(),
    contextWindowDefault: "1m",
    ...extra,
  };
  return createManifestSnapshot("anthropic", {
    discovery: { anthropic: "refreshable" },
    providers: { anthropic: { models: [model] } },
  });
}

const fableEntry = {
  id: "claude-fable-5",
  name: "Claude Fable 5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
} satisfies ModelCatalogEntry;

async function build(
  params: Partial<BuildPreparedModelCatalogParams> & { entries?: ModelCatalogEntry[] },
) {
  return await buildPreparedModelCatalogSnapshot({
    agentDir: "/tmp/model-catalog-test",
    authCredentials: params.authCredentials ?? {},
    config: params.config ?? { plugins: { enabled: false } },
    metadataSnapshot: params.metadataSnapshot ?? metadataSnapshot,
    models: params.entries ?? [],
    readOnly: params.readOnly ?? true,
    providerOutcomes: params.providerOutcomes,
    includeProviderPluginAugmentation: params.includeProviderPluginAugmentation,
  });
}

const customRoute = {
  provider: "custom",
  api: "openai-responses",
  baseUrl: "https://route-a.example.test/v1",
} as const;

beforeEach(() => {
  mocks.augmentModelCatalogWithProviderPlugins.mockReset();
  mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([]);
});

it("keeps replace publication closed to a warm refreshable inventory", async () => {
  mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([
    row("manifest-provider", "augmented-only", { name: "Augmented" }),
  ]);
  const config: OpenClawConfig = { models: { catalogRefresh: { enabled: false } } };
  const manifest = providerManifestSnapshot("manifest-provider", "refreshable", ["manifest-only"]);
  expect(loadManifestModelCatalog({ config, metadataSnapshot: manifest })).toHaveLength(1);
  config.models = { ...config.models, mode: "replace", providers: {} };
  expect(
    loadManifestModelCatalog({
      config,
      get metadataSnapshot(): never {
        throw new Error("replace must not resolve manifest metadata");
      },
    }),
  ).toEqual([]);
  const snapshot = await build({
    config,
    metadataSnapshot: manifest,
    readOnly: false,
    includeProviderPluginAugmentation: true,
  });
  expect([snapshot.entries, snapshot.routeVariants]).toEqual([[], []]);
  expect(mocks.augmentModelCatalogWithProviderPlugins).not.toHaveBeenCalled();
});

it("preserves ready provider membership without replenishing it from metadata", async () => {
  const entries: ModelCatalogEntry[] = [];
  mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([
    row("demo", "augmentation", { name: "Augmentation" }),
  ]);
  const snapshot = await build({
    metadataSnapshot: providerManifestSnapshot("demo", "refreshable", ["manifest-only"]),
    entries,
    providerOutcomes: [{ provider: "demo", status: "ready" }],
    readOnly: false,
  });
  expect(snapshot).toMatchObject({ entries, routeVariants: entries, authoritative: true });
});

it.each(["unowned", "disabled"] as const)(
  "ignores %s provider-alias declarations",
  async (kind) => {
    const plugin = createPluginManifestRecordFixture({
      id: "alias-owner",
      origin: "bundled",
      providers: kind === "unowned" ? ["unrelated"] : ["target"],
      modelCatalog: { aliases: { source: { provider: "target" } } },
    });
    const snapshot = await build({
      config: { plugins: { entries: { "alias-owner": { enabled: kind !== "disabled" } } } },
      metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [plugin] }),
      entries: [row("source", "model", { name: "Model" })],
    });
    expect(snapshot.entries).toMatchObject([{ provider: "source", id: "model" }]);
  },
);

const discoveredRow = (id: string) => ({
  id,
  name: id,
  reasoning: false,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
});

it("publishes the family a discovered row or its manifest declares, and none otherwise", async () => {
  const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
  // A routing provider's discovery names each row's family from its own service metadata.
  registry.registerProvider("router", {
    api: "openai-responses",
    baseUrl: "https://router.example/v1",
    models: [
      { ...discoveredRow("anthropic/claude-model"), family: "anthropic" },
      discoveredRow("acme/claude-model"),
    ],
  });
  const snapshot = await buildPreparedModelCatalogSnapshot({
    agentDir: "/tmp/model-catalog-test",
    authCredentials: {},
    config: { plugins: { enabled: false } },
    readOnly: true,
    models: registry.getAll(),
    metadataSnapshot: createManifestSnapshot("native", {
      providers: {
        native: {
          api: "anthropic-messages",
          baseUrl: "https://native.example",
          family: "anthropic",
          models: [{ id: "native-model", name: "Native" }],
        },
      },
      discovery: { native: "static" },
    }),
  });
  const families = Object.fromEntries(
    snapshot.entries.map((entry) => [`${entry.provider}/${entry.id}`, entry.family]),
  );
  expect(families).toEqual({
    "native/native-model": "anthropic",
    "router/anthropic/claude-model": "anthropic",
    "router/acme/claude-model": undefined,
  });
  expect(snapshot.routeVariants.find(({ id }) => id === "anthropic/claude-model")?.family).toBe(
    "anthropic",
  );
});

it("carries manifest capability metadata into the prepared catalog", async () => {
  const snapshot = fableManifest({
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
  });

  const entries = loadManifestModelCatalog({ config: {}, metadataSnapshot: snapshot });
  expect(entries.find((entry) => entry.id === "claude-fable-5")).toMatchObject({
    contextWindows: fableWindows(),
    contextWindowDefault: "1m",
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
  });
});

it.each([false, true])(
  "drops stale context choices after discovery (configured: %s)",
  async (configured) => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
      {
        ...fableEntry,
        contextWindow: 200_000,
        contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
      },
    ]);
    const snapshot = await build({
      config: configured
        ? providerConfig("anthropic", {
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
            models: [configuredModel("claude-fable-5", { name: "Claude Fable 5" })],
          })
        : undefined,
      metadataSnapshot: fableManifest(),
      entries: [
        {
          ...fableEntry,
          contextWindows: fableWindows(),
          contextWindowDefault: "1m",
        },
      ],
      readOnly: false,
    });

    const merged = findModelCatalogEntry(snapshot.entries, {
      provider: "anthropic",
      modelId: "claude-fable-5",
    });
    expect(merged?.contextWindows).toEqual([{ id: "200k", label: "200K", contextWindow: 200_000 }]);
    expect(merged?.contextWindowDefault).toBeUndefined();
    const route = snapshot.routeVariants.find(
      (entry) => entry.provider === "anthropic" && entry.api === "anthropic-messages",
    );
    expect(route?.contextWindows).toEqual(merged?.contextWindows);
    expect(route?.contextWindowDefault).toBeUndefined();
  },
);

it("canonicalizes manifest-owned provider aliases in registry rows", async () => {
  const snapshot = await build({
    entries: [
      row("moonshotai", "kimi-k3", { name: "Kimi K3" }),
      row("moonshot-ai", "kimi-k2.7-code", { name: "Kimi K2.7 Code" }),
    ],
    metadataSnapshot: providerManifestSnapshot(
      "moonshot",
      "static",
      ["kimi-k3", "kimi-k2.7-code"],
      ["moonshotai", "moonshot-ai"],
    ),
  });

  expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
    "moonshot/kimi-k3",
    "moonshot/kimi-k2.7-code",
  ]);
});

it("uses an explicitly ready live catalog order across entries and route variants", async () => {
  const manifestSnapshot = providerManifestSnapshot("demo", "runtime", ["first", "second"]);
  const entries = ["second", "first", "new"].map((id) =>
    row("demo", id, { api: "openai-responses" }),
  );
  const modelOrder = ["second", "new", "first", "absent"];
  const snapshot = await build({
    entries,
    metadataSnapshot: manifestSnapshot,
    providerOutcomes: [{ provider: "demo", status: "ready", modelOrder }],
  });

  expect(snapshot.entries.map(({ id }) => id)).toEqual(["second", "new", "first"]);
  expect(snapshot.routeVariants.map(({ id }) => id)).toEqual(["second", "new", "first"]);
  expect(snapshot.entries.map(({ providerOrder }) => providerOrder)).toEqual([0, 1, 2]);
  expect(snapshot.entries).toHaveLength(entries.length);

  const withoutOptIn = await build({ entries, metadataSnapshot: manifestSnapshot });
  expect(withoutOptIn.entries.map(({ id }) => id)).toEqual(["first", "second", "new"]);
});

it("keeps manifest rank for configured runtime models absent from the registry", async () => {
  mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
    row("openai", "gpt-5.4", { name: "GPT-5.4" }),
    row("openai", "gpt-5.6-sol", { name: "GPT-5.6 Sol" }),
  ]);

  const snapshot = await build({
    config: providerConfig("openai", {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [configuredModel("gpt-5.6-sol")],
    }),
    entries: [row("openai", "gpt-5.4", { name: "GPT-5.4" })],
    metadataSnapshot: providerManifestSnapshot("openai", "runtime", ["gpt-5.6-sol", "gpt-5.4"]),
    readOnly: false,
  });

  expect(snapshot.entries.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
});

it("overlays exact configured metadata when discovery and config have opposite model order", async () => {
  const models = ["Reader", "reader"].map((id, index) =>
    configuredModel(id, {
      name: `Configured ${id}`,
      contextWindow: 32_000 * (index + 1),
      maxTokens: 4_096,
      reasoning: index === 0,
      thinkingLevelMap: { off: null, xhigh: "xhigh" },
      input: index === 0 ? ["text", "image"] : ["text"],
    }),
  );
  const snapshot = await build({
    config: providerConfig("custom", {
      baseUrl: "https://example.test/v1",
      api: "openai-completions",
      models: models.toReversed(),
    }),
    entries: models.map(({ id }) =>
      row("custom", id, { name: `Discovered ${id}`, input: ["text"] }),
    ),
  });

  expect(snapshot.entries).toHaveLength(models.length);
  for (const model of models) {
    const expected = {
      id: model.id,
      api: "openai-completions",
      contextWindow: model.contextWindow,
      reasoning: model.reasoning,
      configuredReasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input,
    };
    expect(
      findModelCatalogEntry(snapshot.entries, { provider: "custom", modelId: model.id }),
    ).toMatchObject({
      ...expected,
      name: `Discovered ${model.id}`,
    });
    expect(snapshot.routeVariants).toContainEqual(
      expect.objectContaining({ ...expected, name: model.name }),
    );
  }
  expect(snapshot.routeVariants).toHaveLength(4);
});

it("applies model-pinned routes to captured catalog entries", async () => {
  const defaults = {
    api: "openai-completions",
    baseUrl: "https://provider.example.test/v1",
  } as const;
  const captured = {
    api: "openai-responses",
    baseUrl: "https://account.example.test/v1",
  } as const;
  const configured = configuredModel("demo", {
    name: "Configured Demo",
    contextWindow: 32_000,
    input: ["text", "image"],
    ...defaults,
  });
  const config = providerConfig("custom", { ...defaults, models: [configured] });
  const snapshot = await build({
    config,
    entries: [{ provider: "custom", id: "demo", name: "Captured Demo", ...captured }],
  });
  const policy = createModelVisibilityPolicy({
    cfg: config,
    catalog: snapshot.entries,
    defaultProvider: "custom",
    manifestPlugins: metadataSnapshot,
  });

  for (const catalog of [snapshot.entries, policy.configuredCatalog]) {
    expect(catalog).toEqual([
      expect.objectContaining({
        provider: "custom",
        id: "demo",
        ...defaults,
        contextWindow: 32_000,
        reasoning: true,
        input: ["text", "image"],
      }),
    ]);
  }
  expect(snapshot.routeVariants).toContainEqual(expect.objectContaining(defaults));
  expect(snapshot.routeVariants).toHaveLength(2);
});

it("keeps the first matching catalog route after borrowed-row retargeting", async () => {
  mocks.augmentModelCatalogWithProviderPlugins.mockImplementationOnce(async ({ context }) => {
    const first = context.entries[0];
    if (first) {
      first.id = "demo";
    }
    return [
      {
        ...customRoute,
        id: "demo",
        name: "Route B",
        api: "openai-completions",
        baseUrl: "https://route-b.example.test/v1",
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        compat: { supportsTools: false },
      },
    ];
  });
  const snapshot = await build({
    config: providerConfig("custom", {
      api: customRoute.api,
      baseUrl: customRoute.baseUrl,
      models: [configuredModel("demo")],
    }),
    entries: [
      {
        ...customRoute,
        id: "spare",
        name: "Earlier Route A",
        thinkingLevelMap: { xhigh: "high", max: "max" },
        compat: { supportsTools: false },
      },
      {
        ...customRoute,
        id: "demo",
        name: "Route A",
        thinkingLevelMap: { xhigh: null, max: null },
        compat: { supportsTools: true },
      },
    ],
    readOnly: false,
  });

  const selectedRoute = {
    name: "Earlier Route A",
    api: "openai-responses",
    baseUrl: "https://route-a.example.test/v1",
    thinkingLevelMap: { xhigh: "high", max: "max" },
    compat: { supportsTools: false },
  };
  expect(
    snapshot.entries.filter((entry) => entry.provider === "custom" && entry.id === "demo"),
  ).toEqual(Array.from({ length: 2 }, () => expect.objectContaining(selectedRoute)));
  expect(
    snapshot.routeVariants.filter(
      (entry) => entry.id === "demo" && entry.api === "openai-responses",
    ),
  ).toHaveLength(2);
});

it("uses the lifecycle auth snapshot for provider catalog augmentation", async () => {
  let resolvedKey: string | undefined;
  let resolvedOAuth: string | undefined;
  mocks.augmentModelCatalogWithProviderPlugins.mockImplementationOnce(async ({ context }) => {
    if (!context.resolveProviderApiKey) {
      throw new Error("expected lifecycle auth resolver");
    }
    resolvedKey = context.resolveProviderApiKey("inherited").apiKey;
    resolvedOAuth = context.resolveProviderApiKey("subscription").apiKey;
    return [];
  });

  await build({
    authCredentials: {
      inherited: { type: "api_key", key: "test-api-key" },
      subscription: {
        type: "oauth",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    readOnly: false,
  });

  expect(resolvedKey).toBe("test-api-key");
  expect(resolvedOAuth).toBe(resolveOAuthApiKeyMarker("subscription"));
  expect(mocks.augmentModelCatalogWithProviderPlugins).toHaveBeenCalledWith(
    expect.objectContaining({ metadataSnapshot }),
  );
});

it("reports image capability from the prepared row", () => {
  const entry: ModelCatalogEntry = {
    id: "media",
    name: "Media",
    provider: "test",
    input: ["text", "image", "document"],
  };
  expect(modelSupportsVision(entry)).toBe(true);
});

describe("model catalog metadata projection", () => {
  it("retains runtime capabilities without exporting request credentials", () => {
    const capabilities = row("custom", "configured-model", {
      name: "Configured model",
      api: "openai-responses",
      baseUrl: "https://example.test/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 96_000,
      contextTokens: 48_000,
      parameterCount: 4_000_000_000,
      contextWindows: [{ id: "large", label: "Large", contextWindow: 96_000 }],
      contextWindowDefault: "large",
      thinkingLevelMap: { off: null, high: "high" },
      params: { platformOnly: true },
      compat: { supportsTools: false },
    });
    const model = {
      ...capabilities,
      headers: { Authorization: "synthetic-unused" },
      authHeader: true,
      requestTimeoutMs: 12_000,
    };
    const entry = modelCatalogRowToEntry(model);
    expect(entry).toMatchObject(capabilities);
    expect(entry).not.toHaveProperty("headers");
    expect(entry).not.toHaveProperty("authHeader");
    expect(entry).not.toHaveProperty("requestTimeoutMs");
  });
  it("uses the provider label for an unnamed native model without borrowing capabilities", () => {
    const native = row("meta", "muse-spark-1.3", { nativeRuntime: "muse" });
    const entries = [
      { ...native, nativeRuntime: undefined, name: "Muse Spark 1.3", contextWindow: 128000 },
    ];
    expect(enrichHarnessRows([native], { entries, routeVariants: [] })).toEqual([
      { ...native, name: "Muse Spark 1.3" },
    ]);
  });
  it("keeps synthetic provenance bound to the context metadata and route that supplied it", () => {
    const identity = row("fixture", "m", { name: "M" });
    const base = {
      ...identity,
      api: "openai-responses" as const,
      baseUrl: "https://first.example/v1",
      contextWindow: 128_000,
      contextWindowSource: "synthetic" as const,
      parameterCount: 4_000_000_000,
    };
    const overlay = (fields: Partial<ModelCatalogEntry>) =>
      overlayCatalogMetadata(base, { ...identity, ...fields });
    expect(
      overlay({ ...base, contextWindow: 64_000, contextWindowSource: undefined })
        .contextWindowSource,
    ).toBeUndefined();
    const moved = overlay({ baseUrl: "https://second.example/v1" });
    expect(moved.contextWindowSource).toBeUndefined();
    expect(moved.parameterCount).toBeUndefined();
    expect(overlay({ reasoning: true }).contextWindowSource).toBe("synthetic");
  });
});

describe("configured catalog metadata", () => {
  const identity = row("custom", "plain", { name: "Captured model" });
  const capturedMetadata = {
    ...identity,
    api: "openai-responses",
    reasoning: true,
    thinkingLevelMap: { high: "high" },
    contextWindows: [{ id: "large", label: "Large", contextWindow: 32_000 }],
    contextWindowDefault: "large",
    params: { captured: true },
    compat: { supportsTools: false },
  } satisfies ModelCatalogEntry;
  const defaults: Pick<ModelProviderConfig, "api" | "baseUrl"> = {
    api: "openai-completions",
    baseUrl: "https://configured.example.test/v1",
  };
  function config<T extends Partial<ModelDefinitionConfig>>(model: T, route = defaults) {
    return {
      plugins: { enabled: false },
      models: { providers: { custom: { ...route, models: [model] } } },
    };
  }

  it("clears captured capabilities when applying a previously missing base URL", () => {
    const route = { ...defaults, api: "openai-responses" } as const;
    const source = validateConfigObjectRaw(
      config({ id: "plain", name: "Configured model", ...route }, route),
    );
    if (!source.ok) {
      throw new Error(JSON.stringify(source.issues));
    }
    const captured: ModelCatalogEntry & ThinkingCatalogPolicyCarrier = {
      ...capturedMetadata,
      thinkingPolicyProvider: "captured-policy",
      [PREPARED_THINKING_POLICY]: {
        resolve: () => ({ levels: [{ id: "high" }], defaultLevel: "high" }),
      },
      contextWindow: 32_000,
      contextTokens: 16_000,
      input: ["text", "image"],
      mediaInput: { image: { maxBytes: 4_096 } },
    };
    const catalog = Object.freeze([Object.freeze(captured)]);
    const [entry] = overlayConfiguredModelCatalog({ catalog, config: source.config });
    expect(entry).toEqual({ ...identity, ...route, compat: undefined });
    expect(catalog).toEqual([captured]);
    expect(captured.thinkingLevelMap).toEqual({ high: "high" });
  });
  it("keeps capabilities with their captured route when provider defaults differ", () => {
    const captured: ModelCatalogEntry = Object.freeze({
      ...capturedMetadata,
      baseUrl: "https://captured.example.test/v1",
    });
    const catalog = Object.freeze([captured]);
    const [entry] = overlayConfiguredModelCatalog({
      catalog,
      config: config({
        id: "plain",
        name: "Configured model",
        reasoning: false,
        thinkingLevelMap: { high: null },
        contextWindow: 8192,
        maxTokens: 2048,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsTools: true },
      }),
    });
    expect(entry).toMatchObject({
      api: captured.api,
      baseUrl: captured.baseUrl,
      reasoning: false,
      configuredReasoning: false,
      thinkingLevelMap: { high: null },
      compat: { supportsTools: false },
      contextWindows: captured.contextWindows,
      contextWindowDefault: "large",
      params: captured.params,
    });
    expect(catalog).toEqual([captured]);
    expect(captured).toMatchObject({ reasoning: true, thinkingLevelMap: { high: "high" } });
  });
});

describe("catalog declaration planning", () => {
  const plan = vi.mocked(planEffectiveModelCatalogRows);
  const normalize = vi.mocked(normalizeModelCatalogProviderRows);
  let config: OpenClawConfig;
  function catalog(discovery: "static" | "runtime", ...modelIds: string[]) {
    const planningMetadata = finalizePluginMetadataSnapshot(
      providerManifestSnapshot("catalog-fixture", discovery, modelIds),
    );
    const params = { config, metadataSnapshot: planningMetadata };
    return {
      load: () => loadManifestModelCatalog(params),
      build: () =>
        buildPreparedModelCatalogSnapshot({
          ...params,
          agentDir: "/tmp/model-catalog-planning-test",
          authCredentials: {},
          readOnly: true,
          models: [],
        }),
      scope: (run: () => Promise<void>) => withPluginRuntimeGenerationScope(params, run),
    };
  }
  beforeEach(() => {
    config = { plugins: { enabled: false } };
    plan.mockReset();
    normalize.mockReset();
  });
  afterEach(() => {
    plan.mockReset();
    normalize.mockReset();
  });
  it("plans manifest rows once without expanding entitlement", async () => {
    const runtime = catalog("runtime", "allowed", "denied");
    config.models = { catalogRefresh: { enabled: false } };
    await runtime.scope(async () => {
      plan.mockClear();
      normalize.mockClear();
      const snapshot = await runtime.build();
      expect([snapshot.entries, snapshot.routeVariants]).toEqual([[], []]);
      const firstRead = runtime.load();
      expect(firstRead.map((entry) => entry.id)).toEqual(["allowed", "denied"]);
      expect(runtime.load()).toBe(firstRead);
      expect(mocks.augmentModelCatalogWithProviderPlugins).not.toHaveBeenCalled();
      expect(plan).toHaveBeenCalledTimes(1);
      expect(
        normalize.mock.results.map(({ type, value }) => (type === "return" ? value.length : type)),
      ).toEqual([2]);
    });
  });
  it("keeps the old declaration cache when replacement planning fails", async () => {
    const initial = catalog("static", "initial");
    const replacement = catalog("static", "replacement");
    const planningError = new Error("catalog planning failed");
    const originalRows = initial.load();
    await replacement.scope(async () => {
      plan.mockImplementationOnce(() => {
        throw planningError;
      });
      await expect(replacement.build()).rejects.toBe(planningError);
      expect(initial.load()).toBe(originalRows);
      const snapshot = await replacement.build();
      expect(snapshot.entries.map((entry) => entry.id)).toEqual(["replacement"]);
      const replacementRows = replacement.load();
      expect(replacementRows.map((entry) => entry.id)).toEqual(["replacement"]);
      expect(replacementRows).not.toBe(originalRows);
      expect(replacement.load()).toBe(replacementRows);
      expect(originalRows.map((entry) => entry.id)).toEqual(["initial"]);
    });
  });
});
