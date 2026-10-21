import type {
  ModelCatalog,
  ModelCatalogModel,
} from "@openclaw/model-catalog-core/model-catalog-types";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import { modelDefinition as configuredModel } from "./model-auth.fixtures.test-support.js";
import {
  buildPreparedModelCatalogSnapshot,
  type BuildPreparedModelCatalogParams,
  findModelCatalogEntry,
  loadManifestModelCatalog,
  modelSupportsVision,
} from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

type AugmentModelCatalogWithProviderPlugins =
  typeof import("../plugins/provider-runtime.js").augmentModelCatalogWithProviderPlugins;

const mocks = vi.hoisted(() => ({
  augmentModelCatalogWithProviderPlugins: vi.fn<AugmentModelCatalogWithProviderPlugins>(
    async () => [],
  ),
}));

// mock-isolation: catalog tests supply provider metadata without loading provider runtimes.
vi.mock("../plugins/provider-runtime.runtime.js", () => mocks);

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

function fableManifest(extra: Partial<ModelCatalogModel> = {}) {
  const model: ModelCatalogModel = {
    id: "claude-fable-5",
    contextWindow: 1_000_000,
    contextWindows: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
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
    { provider: "manifest-provider", id: "augmented-only", name: "Augmented" },
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
    { provider: "demo", id: "augmentation", name: "Augmentation" },
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
      entries: [{ provider: "source", id: "model", name: "Model" }],
    });
    expect(snapshot.entries).toMatchObject([{ provider: "source", id: "model" }]);
  },
);

it("carries manifest capability metadata into the prepared catalog", async () => {
  const snapshot = fableManifest({
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
  });

  const entries = loadManifestModelCatalog({ config: {}, metadataSnapshot: snapshot });
  expect(entries.find((entry) => entry.id === "claude-fable-5")).toMatchObject({
    contextWindows: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
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
          contextWindows: [
            { id: "200k", label: "200K", contextWindow: 200_000 },
            { id: "1m", label: "1M", contextWindow: 1_000_000 },
          ],
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
      { id: "kimi-k3", name: "Kimi K3", provider: "moonshotai" },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code", provider: "moonshot-ai" },
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
  const entries: ModelCatalogEntry[] = ["second", "first", "new"].map((id) => ({
    provider: "demo",
    id,
    name: id,
    api: "openai-responses",
  }));
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
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", provider: "openai" },
  ]);

  const snapshot = await build({
    config: providerConfig("openai", {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      models: [configuredModel("gpt-5.6-sol")],
    }),
    entries: [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai" }],
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
    entries: models.map(({ id }) => ({
      id,
      name: `Discovered ${id}`,
      provider: "custom",
      input: ["text"],
    })),
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
