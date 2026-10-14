import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import { resolveOAuthApiKeyMarker } from "./model-auth-markers.js";
import {
  buildPreparedModelCatalogSnapshot,
  findModelCatalogEntry,
  loadManifestModelCatalog,
  modelSupportsVision,
} from "./model-catalog.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

type AugmentModelCatalogWithProviderPlugins =
  typeof import("../plugins/provider-runtime.js").augmentModelCatalogWithProviderPlugins;

const mocks = vi.hoisted(() => ({
  augmentModelCatalogWithProviderPlugins: vi.fn<AugmentModelCatalogWithProviderPlugins>(
    async () => [],
  ),
}));

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: (
    ...args: Parameters<AugmentModelCatalogWithProviderPlugins>
  ) => mocks.augmentModelCatalogWithProviderPlugins(...args),
}));

const metadataSnapshot = createPluginMetadataSnapshotFixture();

function providerManifestSnapshot(params: {
  provider: string;
  discovery: "static" | "refreshable" | "runtime";
  modelIds: string[];
  aliases?: string[];
  modelAliases?: Record<string, string>;
}): PluginMetadataSnapshot {
  const plugin = createPluginManifestRecordFixture({
    id: params.provider,
    origin: "bundled",
    providers: [params.provider],
    ...(params.modelAliases
      ? {
          modelIdNormalization: {
            providers: { [params.provider]: { aliases: params.modelAliases } },
          },
        }
      : {}),
    modelCatalog: {
      aliases: Object.fromEntries(
        (params.aliases ?? []).map((alias) => [alias, { provider: params.provider }]),
      ),
      providers: {
        [params.provider]: {
          api: "openai-responses",
          models: params.modelIds.map((id) => ({ id, name: id })),
        },
      },
      discovery: { [params.provider]: params.discovery },
    },
  });
  return createPluginMetadataSnapshotFixture({ plugins: [plugin] });
}

async function build(params: {
  config?: OpenClawConfig;
  entries?: ModelCatalogEntry[];
  metadataSnapshot?: PluginMetadataSnapshot;
  readOnly?: boolean;
  includeProviderPluginAugmentation?: boolean;
  providerOutcomes?: ModelCatalogSnapshot["providerOutcomes"];
}) {
  return await buildPreparedModelCatalogSnapshot({
    agentDir: "/tmp/model-catalog-test",
    authCredentials: {},
    config: params.config ?? { plugins: { enabled: false } },
    metadataSnapshot: params.metadataSnapshot ?? metadataSnapshot,
    models: params.entries ?? [],
    readOnly: params.readOnly ?? true,
    providerOutcomes: params.providerOutcomes,
    ...(params.includeProviderPluginAugmentation !== undefined
      ? { includeProviderPluginAugmentation: params.includeProviderPluginAugmentation }
      : {}),
  });
}

describe("prepared model catalog builder", () => {
  beforeEach(() => {
    mocks.augmentModelCatalogWithProviderPlugins.mockReset();
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([]);
  });

  it("keeps replace publication closed to a warm refreshable inventory", async () => {
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([
      { provider: "manifest-provider", id: "augmented-only", name: "Augmented" },
    ]);
    const config: OpenClawConfig = { models: { catalogRefresh: { enabled: false } } };
    const manifest = providerManifestSnapshot({
      provider: "manifest-provider",
      discovery: "refreshable",
      modelIds: ["manifest-only"],
    });
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
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.routeVariants).toEqual([]);
    expect(mocks.augmentModelCatalogWithProviderPlugins).not.toHaveBeenCalled();
  });

  it("preserves ready provider membership without replenishing it from metadata", async () => {
    const entries: ModelCatalogEntry[] = [];
    mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValue([
      { provider: "demo", id: "augmentation", name: "Augmentation" },
    ]);
    const snapshot = await build({
      metadataSnapshot: providerManifestSnapshot({
        provider: "demo",
        discovery: "refreshable",
        modelIds: ["manifest-only"],
      }),
      entries,
      providerOutcomes: [{ provider: "demo", status: "ready" }],
      readOnly: false,
    });
    expect(snapshot.entries).toMatchObject(entries);
    expect(snapshot.routeVariants).toMatchObject(entries);
    expect(snapshot.authoritative).toBe(true);
  });

  it("projects and sorts one lifecycle registry generation", async () => {
    const snapshot = await build({
      entries: [
        { id: "z", name: "Zulu", provider: "beta", input: ["text"] },
        {
          id: "a",
          name: "Alpha",
          provider: "alpha",
          contextWindow: 64_000,
          thinkingLevelMap: { off: null, max: "max" },
          input: ["text", "image"],
        },
      ],
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "alpha/a",
      "beta/z",
    ]);
    expect(snapshot.entries[0]?.thinkingLevelMap).toEqual({ off: null, max: "max" });
    expect(snapshot.routeVariants).toEqual(snapshot.entries);
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
    const plugin = createPluginManifestRecordFixture({
      id: "anthropic",
      origin: "bundled",
      providers: ["anthropic"],
      modelCatalog: {
        providers: {
          anthropic: {
            models: [
              {
                id: "claude-fable-5",
                contextWindow: 1_000_000,
                contextWindows: [
                  { id: "200k", label: "200K", contextWindow: 200_000 },
                  { id: "1m", label: "1M", contextWindow: 1_000_000 },
                ],
                contextWindowDefault: "1m",
                thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
                input: ["text", "image"],
                mediaInput: { image: { maxBytes: 4096, tokenMode: "tile" } },
              },
            ],
          },
        },
        discovery: { anthropic: "refreshable" },
      },
    });
    const snapshot = createPluginMetadataSnapshotFixture({ plugins: [plugin] });

    expect(
      loadManifestModelCatalog({ config: {}, metadataSnapshot: snapshot }).find(
        (entry) => entry.id === "claude-fable-5",
      ),
    ).toMatchObject({
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
      const plugin = createPluginManifestRecordFixture({
        id: "anthropic",
        origin: "bundled",
        providers: ["anthropic"],
        modelCatalog: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-fable-5",
                  contextWindow: 1_000_000,
                  contextWindows: [
                    { id: "200k", label: "200K", contextWindow: 200_000 },
                    { id: "1m", label: "1M", contextWindow: 1_000_000 },
                  ],
                  contextWindowDefault: "1m",
                },
              ],
            },
          },
          discovery: { anthropic: "refreshable" },
        },
      });
      // Live provider discovery overlays the manifest row but replaces the
      // options list without restating a default.
      mocks.augmentModelCatalogWithProviderPlugins.mockResolvedValueOnce([
        {
          id: "claude-fable-5",
          name: "Claude Fable 5",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com",
          contextWindow: 200_000,
          contextWindows: [{ id: "200k", label: "200K", contextWindow: 200_000 }],
        },
      ]);
      const snapshot = await build({
        config: configured
          ? {
              plugins: { enabled: false },
              models: {
                providers: {
                  anthropic: {
                    api: "anthropic-messages",
                    baseUrl: "https://api.anthropic.com",
                    models: [
                      {
                        id: "claude-fable-5",
                        name: "Claude Fable 5",
                        reasoning: true,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        maxTokens: 8192,
                      },
                    ],
                  },
                },
              },
            }
          : undefined,
        metadataSnapshot: createPluginMetadataSnapshotFixture({ plugins: [plugin] }),
        entries: [
          {
            id: "claude-fable-5",
            name: "Claude Fable 5",
            provider: "anthropic",
            api: "anthropic-messages",
            baseUrl: "https://api.anthropic.com",
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
      // Options + default are one normalized unit: the overlay owns both, so the
      // base "1m" default absent from the replacement list must not leak through.
      expect(merged?.contextWindows).toEqual([
        { id: "200k", label: "200K", contextWindow: 200_000 },
      ]);
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
      metadataSnapshot: providerManifestSnapshot({
        provider: "moonshot",
        aliases: ["moonshotai", "moonshot-ai"],
        discovery: "static",
        modelIds: ["kimi-k3", "kimi-k2.7-code"],
      }),
    });

    expect(snapshot.entries.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "moonshot/kimi-k3",
      "moonshot/kimi-k2.7-code",
    ]);
  });

  it("uses an explicitly ready live catalog order across entries and route variants", async () => {
    const manifestSnapshot = providerManifestSnapshot({
      provider: "demo",
      discovery: "runtime",
      modelIds: ["first", "second"],
    });
    const entries = [
      { provider: "demo", id: "second", name: "Second", api: "openai-responses" as const },
      { provider: "demo", id: "first", name: "First", api: "openai-responses" as const },
      { provider: "demo", id: "new", name: "New", api: "openai-responses" as const },
    ];
    const liveOrder = {
      provider: "demo",
      status: "ready" as const,
      modelOrder: ["second", "new", "first", "absent"],
    };
    const snapshot = await build({
      entries,
      metadataSnapshot: manifestSnapshot,
      providerOutcomes: [liveOrder],
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
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.6-sol",
                  name: "Configured GPT-5.6 Sol",
                  contextWindow: 1_050_000,
                  maxTokens: 128_000,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      entries: [{ id: "gpt-5.4", name: "GPT-5.4", provider: "openai" }],
      metadataSnapshot: providerManifestSnapshot({
        provider: "openai",
        discovery: "runtime",
        modelIds: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"],
      }),
      readOnly: false,
    });

    expect(snapshot.entries.map((entry) => entry.id)).toEqual(["gpt-5.6-sol", "gpt-5.4"]);
  });

  it("overlays exact configured metadata when discovery and config have opposite model order", async () => {
    const models = ["Reader", "reader"].map<ModelDefinitionConfig>((id, index) => ({
      id,
      name: `Configured ${id}`,
      contextWindow: 32_000 * (index + 1),
      maxTokens: 4_096,
      reasoning: index === 0,
      thinkingLevelMap: { off: null, xhigh: "xhigh" },
      input: index === 0 ? ["text", "image"] : ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }));
    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            custom: {
              baseUrl: "https://example.test/v1",
              api: "openai-completions",
              models: models.toReversed(),
            },
          },
        },
      },
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
      expect(snapshot.routeVariants).toEqual(
        expect.arrayContaining([expect.objectContaining({ ...expected, name: model.name })]),
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
    const configured: ModelDefinitionConfig = {
      id: "demo",
      name: "Configured Demo",
      contextWindow: 32_000,
      maxTokens: 4096,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...defaults,
    };
    const config: OpenClawConfig = {
      plugins: { enabled: false },
      models: { providers: { custom: { ...defaults, models: [configured] } } },
    };
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
          id: "demo",
          name: "Route B",
          provider: "custom",
          api: "openai-completions",
          baseUrl: "https://route-b.example.test/v1",
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
          compat: { supportsTools: false },
        },
      ];
    });
    const snapshot = await build({
      config: {
        plugins: { enabled: false },
        models: {
          providers: {
            custom: {
              api: "openai-responses",
              baseUrl: "https://route-a.example.test/v1",
              models: [
                {
                  id: "demo",
                  name: "Configured Demo",
                  contextWindow: 32_000,
                  maxTokens: 4_096,
                  reasoning: true,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      },
      entries: [
        {
          id: "spare",
          name: "Earlier Route A",
          provider: "custom",
          api: "openai-responses",
          baseUrl: "https://route-a.example.test/v1",
          thinkingLevelMap: { xhigh: "high", max: "max" },
          compat: { supportsTools: false },
        },
        {
          id: "demo",
          name: "Route A",
          provider: "custom",
          api: "openai-responses",
          baseUrl: "https://route-a.example.test/v1",
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

    await buildPreparedModelCatalogSnapshot({
      agentDir: "/tmp/model-catalog-test",
      authCredentials: {
        inherited: { type: "api_key", key: "test-api-key" },
        subscription: {
          type: "oauth",
          access: "test-access",
          refresh: "test-refresh",
          expires: Date.now() + 60_000,
        },
      },
      config: { plugins: { enabled: false } },
      metadataSnapshot,
      models: [],
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
});
