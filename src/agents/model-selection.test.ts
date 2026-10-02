// Exercises core model selection, aliases, and visibility policy.
import { afterEach, describe, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import {
  buildAllowedModelSet,
  inferUniqueProviderFromConfiguredModels,
  resolveBareModelDefaultProvider,
  parseModelRef,
  buildModelAliasIndex,
  resolvePersistedSelectedModelRef,
  resolveAllowedModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
  resolveSubagentSpawnModelSelection,
  resolveModelRefFromString,
} from "./model-selection.js";
import { createModelVisibilityPolicy } from "./model-visibility-policy.js";

const manifestNormalizationSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "model-selection-test-normalizers",
      providers: ["nvidia", "fixture-route"],
      modelIdNormalization: {
        providers: {
          nvidia: { aliases: { "llama-fast": "nvidia/canonical-fast" } },
          "fixture-route": { aliases: { raw: "canonical" } },
        },
      },
    },
  ],
});

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => manifestNormalizationSnapshot,
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("./model-selection-cli.js", () => ({ isCliProvider: () => false }));

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

function createConfiguredModelRefConfig(params: {
  primary?: string;
  modelEntries?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  allow?: string[];
}) {
  return {
    ...(params.primary !== undefined || params.modelEntries || params.allow !== undefined
      ? {
          agents: {
            defaults: {
              ...(params.primary !== undefined ? { model: { primary: params.primary } } : {}),
              ...(params.modelEntries ? { models: params.modelEntries } : {}),
              ...(params.allow !== undefined ? { modelPolicy: { allow: params.allow } } : {}),
            },
          },
        }
      : {}),
    ...(params.providers ? { models: { providers: params.providers } } : {}),
  } as unknown as OpenClawConfig;
}

function createSubagentSelectionConfig(params: {
  defaultPrimary?: string;
  modelEntries?: Record<string, unknown>;
  defaultSubagentModel?: string;
  agents?: Array<Record<string, unknown>>;
}) {
  return {
    agents: {
      defaults: {
        model: { primary: params.defaultPrimary ?? "anthropic/claude-sonnet-4-6" },
        ...(params.modelEntries ? { models: params.modelEntries } : {}),
        ...(params.defaultSubagentModel
          ? { subagents: { model: params.defaultSubagentModel } }
          : {}),
      },
      ...(params.agents ? { list: params.agents } : {}),
    },
  } as unknown as OpenClawConfig;
}

function createProviderInferenceCatalogConfig(providers: Record<string, string[]>) {
  return {
    models: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([provider, modelIds]) => [
          provider,
          { models: modelIds.map((id) => ({ id })) },
        ]),
      ),
    },
  } as unknown as OpenClawConfig;
}

function resolveConfiguredRefForTest(
  cfg: Partial<OpenClawConfig>,
  options: Partial<Omit<Parameters<typeof resolveConfiguredModelRef>[0], "cfg">> = {},
) {
  return resolveConfiguredModelRef({
    cfg: cfg as OpenClawConfig,
    defaultProvider: "openai",
    defaultModel: "gpt-5.4",
    ...options,
  });
}

it("returns null for invalid refs", () => {
  for (const raw of ["", "  ", "/", "anthropic/", "/model"]) {
    expect(parseModelRef(raw, "anthropic", { allowPluginNormalization: false }), raw).toBeNull();
  }
});

it.each([
  {
    name: "splits legacy combined refs when provider is not stored separately",
    params: {
      defaultProvider: "anthropic",
      overrideModel: "ollama-beelink2/qwen2.5-coder:7b",
    },
    expected: { provider: "ollama-beelink2", model: "qwen2.5-coder:7b" },
  },
  {
    name: "preserves explicit runtime provider for vendor-prefixed model ids",
    params: {
      defaultProvider: "anthropic",
      runtimeProvider: "openrouter",
      runtimeModel: "anthropic/claude-haiku-4.5",
    },
    expected: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
  },
])("$name", ({ params, expected }) => {
  expect(resolvePersistedSelectedModelRef(params)).toEqual(expected);
});

it("ignores malformed persisted model metadata instead of throwing", () => {
  expect(
    resolvePersistedSelectedModelRef({
      defaultProvider: "anthropic",
      runtimeProvider: { provider: "openai" },
      runtimeModel: false,
      overrideProvider: ["openrouter"],
      overrideModel: 123,
    }),
  ).toBeNull();
});

it.each(["SHARED-MODEL"])(
  "prefers a unique agent match over global and provider-config collisions (%s)",
  (agentModel) => {
    const cfg = {
      agents: {
        defaults: { models: { "openai/shared-model": {} } },
        entries: { worker: { models: { [`anthropic/${agentModel}`]: {} } } },
      },
      models: { providers: { minimax: { models: [{ id: "shared-model" }] } } },
    } as unknown as OpenClawConfig;

    expect(
      inferUniqueProviderFromConfiguredModels({
        cfg,
        agentId: "worker",
        model: "shared-model",
      }),
    ).toBe("anthropic");
  },
);

it("keeps ambiguous agent matches unresolved without falling back globally", () => {
  const cfg = {
    agents: {
      defaults: { models: { "openai/shared-model": {} } },
      entries: {
        worker: { models: { "anthropic/shared-model": {}, "minimax/shared-model": {} } },
      },
    },
  } as OpenClawConfig;

  expect(
    inferUniqueProviderFromConfiguredModels({ cfg, agentId: "worker", model: "shared-model" }),
  ).toBeUndefined();
});

describe.each(["defaults", "agent", "configured catalog", "catalog"] as const)(
  "bare provider inference from %s",
  (scope) => {
    it("prefers exact case over ambiguous folded matches", () => {
      const rows = [
        { provider: "first", id: "model", name: "model" },
        { provider: "second", id: "MODEL", name: "MODEL" },
        { provider: "third", id: "Model", name: "Model" },
      ];
      const models = Object.fromEntries(rows.map((row) => [`${row.provider}/${row.id}`, {}]));
      const cfg: OpenClawConfig =
        scope === "defaults"
          ? { agents: { defaults: { models } } }
          : scope === "agent"
            ? { agents: { entries: { worker: { models } } } }
            : scope === "configured catalog"
              ? createProviderInferenceCatalogConfig(
                  Object.fromEntries(rows.map((row) => [row.provider, [row.id]])),
                )
              : {};
      const resolve = (model: string) =>
        resolveBareModelDefaultProvider({
          cfg,
          catalog: scope === "catalog" ? rows : [],
          agentId: "worker",
          model,
          defaultProvider: "fallback",
        });

      expect(resolve(" Model ")).toBe("third");
      expect(resolve("MODEL")).toBe("second");
      expect(resolve("mOdEl")).toBe("fallback");
    });
  },
);

it("disables the global alias with an explicit empty agent alias", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: { models: { "openai/gpt-5.6-luna": { alias: "global-luna" } } },
      entries: { worker: { models: { "openai/gpt-5.6-luna": { alias: "" } } } },
    },
  };
  const index = buildModelAliasIndex({ cfg, agentId: "worker", defaultProvider: "openai" });
  expect(index.byKey.get("openai/gpt-5.6-luna")).toBeUndefined();
  expect(index.byAlias.get("global-luna")).toBeUndefined();
});

it("preserves another model's provider-qualified duplicate alias during replacement", () => {
  const cfg = {
    agents: {
      defaults: {
        models: { "openai/gpt-a": { alias: "shared" }, "openai/gpt-b": { alias: "shared" } },
      },
      entries: { worker: { models: { "openai/gpt-a": { alias: "worker-a" } } } },
    },
  } as OpenClawConfig;

  const index = buildModelAliasIndex({ cfg, agentId: "worker", defaultProvider: "openai" });

  expect(index.byProviderAlias?.get("openai/shared")?.ref).toEqual({
    provider: "openai",
    model: "gpt-b",
  });
  expect(index.byProviderAlias?.get("openai/worker-a")?.ref).toEqual({
    provider: "openai",
    model: "gpt-a",
  });
});

it.each([
  ["absent", true],
  ["reversed", false],
  ["nested-only", true],
] as const)(
  "keeps literal provider-prefixed models visible (%s catalog; reversed policy=%s)",
  (catalogOrder, reversePolicy) => {
    const rows = [
      { provider: "custom", id: "model", name: "model" },
      { provider: "custom", id: "custom/model", name: "custom/model" },
    ];
    const allow = rows.map((entry) => `custom/${entry.id}`);
    if (reversePolicy) {
      allow.reverse();
    }
    const catalogRows =
      catalogOrder === "reversed" || catalogOrder === "nested-only" ? rows.toReversed() : rows;
    const availableRows = catalogOrder.endsWith("-only") ? catalogRows.slice(0, 1) : catalogRows;
    const policy = createModelVisibilityPolicy({
      cfg: createConfiguredModelRefConfig({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://custom.example/v1",
            models: [],
          },
        },
        allow,
      }),
      catalog: [
        ...(catalogOrder === "absent" ? [] : availableRows),
        { provider: "other", id: "model", name: "Excluded" },
      ],
      defaultProvider: "custom",
    });

    expect(policy.allowAny).toBe(false);
    expect([...policy.allowedKeys]).toEqual(["custom/model"]);
    expect(policy.visibleCatalog({ catalog: [], defaultVisibleCatalog: [] })).toEqual(
      catalogOrder === "absent" && reversePolicy ? rows.toReversed() : catalogRows,
    );
  },
);

it.each([
  ["case-insensitive", "Model", "model", false],
  ["literal slash", "team/Reader", "Reader", true],
] as const)(
  "preserves %s matching when only %s is catalogued",
  (_kind, id, missing, expectSynthetic) => {
    const catalog = [{ provider: "custom", id, name: id }];
    const policy = createModelVisibilityPolicy({
      cfg: createConfiguredModelRefConfig({
        providers: {
          custom: {
            api: "openai-completions",
            baseUrl: "https://custom.example/v1",
            models: [],
          },
        },
        allow: [`custom/${id}`, `custom/${missing}`],
      }),
      catalog,
      defaultProvider: "custom",
    });

    expect(policy.visibleCatalog({ catalog: [], defaultVisibleCatalog: [] })).toEqual([
      ...catalog,
      ...(expectSynthetic ? [{ provider: "custom", id: missing, name: missing }] : []),
    ]);
  },
);

it("retains every configured row in a large allowlist without admitting other rows", () => {
  const catalog = Array.from({ length: 400 }, (_, index) => ({
    provider: "custom",
    id: `synthetic-${index}`,
    name: `Synthetic ${index}`,
  }));
  const result = buildAllowedModelSet({
    cfg: createConfiguredModelRefConfig({
      allow: catalog.map((entry) => `custom/${entry.id}`),
    }),
    catalog: [...catalog, { provider: "other", id: "synthetic-0", name: "Other provider" }],
    defaultProvider: "custom",
  });

  expect(result.allowAny).toBe(false);
  expect(result.allowedCatalog).toEqual(catalog);
  expect(result.allowedKeys.size).toBe(400);
});

it("keeps case-insensitive visibility inside the exact provider namespace", () => {
  const result = buildAllowedModelSet({
    cfg: createConfiguredModelRefConfig({ allow: ["custom/team/Reader", "custom/READER"] }),
    catalog: [
      { provider: "custom", id: "team/Reader", name: "Nested model" },
      { provider: "custom/team", id: "Reader", name: "Namespaced provider" },
      { provider: "custom", id: "Reader", name: "Uppercase" },
      { provider: "custom", id: "reader", name: "Lowercase" },
      { provider: "other", id: "READER", name: "Other provider" },
    ],
    defaultProvider: "custom",
  });

  expect(result.allowedCatalog.map(({ provider, id }) => [provider, id])).toEqual([
    ["custom", "team/Reader"],
    ["custom", "Reader"],
    ["custom", "reader"],
    ["custom", "READER"],
  ]);
});

it.each([{ provider: "custom", id: "model", otherProvider: "custom", otherId: "custom/model" }])(
  "keeps metadata on $provider/$id and $otherProvider/$otherId",
  (entry) => {
    const { provider, id, otherProvider, otherId } = entry;
    const rows = [
      { provider, id, name: "Configured primary", contextWindow: 32_000, reasoning: false },
      {
        provider: otherProvider,
        id: otherId,
        name: "Configured sibling",
        contextWindow: 128_000,
        reasoning: true,
      },
    ];
    for (const configuredRows of [rows, rows.toReversed()]) {
      const providers: Record<string, ModelProviderConfig> = {};
      for (const row of configuredRows) {
        const configured = (providers[row.provider] ??= {
          baseUrl: "https://configured.example/v1",
          models: [],
        });
        configured.models.push({
          id: row.id,
          name: row.name,
          contextWindow: row.contextWindow,
          reasoning: row.reasoning,
          input: row.reasoning ? ["text", "image"] : ["text"],
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
      const result = buildAllowedModelSet({
        cfg: createConfiguredModelRefConfig({ providers }),
        catalog: [
          {
            provider,
            id,
            name: "Runtime primary",
            api: "openai-responses",
            baseUrl: "https://captured.example/v1",
          },
        ],
        defaultProvider: "custom",
      });

      expect(result.allowedCatalog).toMatchObject([
        {
          provider,
          id,
          name: "Configured primary",
          contextWindow: 32_000,
          reasoning: false,
          input: ["text"],
          api: "openai-responses",
          baseUrl: "https://captured.example/v1",
        },
        {
          provider: otherProvider,
          id: otherId,
          name: "Configured sibling",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
        },
      ]);
    }
  },
);

it.each(["custom/model"])(
  "keeps synthetic entries sparse when configured metadata belongs to %s",
  (configuredId) => {
    const result = buildAllowedModelSet({
      cfg: createConfiguredModelRefConfig({
        modelEntries: { "custom/model": { alias: "Selected alias" } },
        providers: {
          custom: {
            baseUrl: "https://configured.example/v1",
            models: [
              {
                id: configuredId,
                name: "Unrelated configured name",
                contextWindow: 128_000,
                reasoning: true,
                input: ["text", "image"],
                params: { temperature: 0.5 },
                maxTokens: 4_096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
        allow: ["custom/model"],
      }),
      catalog: [],
      defaultProvider: "custom",
    });

    expect(result.allowedCatalog).toEqual([
      { provider: "custom", id: "model", name: "model", alias: "Selected alias" },
    ]);
  },
);

it("exposes wildcard allow and visible catalog behavior through one policy", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        models: { "openai/*": {}, "anthropic/claude-sonnet-4-6": {} },
        modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] },
      },
    },
  } as unknown as OpenClawConfig;

  const policy = createModelVisibilityPolicy({
    cfg,
    catalog: [
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
      { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
    ],
    defaultProvider: "vllm",
    defaultModel: "qwen-local",
  });

  expect(policy.hasProviderWildcards).toBe(true);
  expect(policy.allowedKeys.has("vllm/qwen-local")).toBe(false);
  expect(policy.allows({ provider: "openai", model: "future-model" })).toBe(true);
  expect(policy.allows({ provider: "vllm", model: "qwen-local" })).toBe(false);
  expect(
    policy.visibleCatalog({
      catalog: [],
      defaultVisibleCatalog: [
        { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
        { provider: "vllm", id: "qwen-local", name: "Qwen Local" },
      ],
    }),
  ).toEqual([
    { provider: "openai", id: "gpt-added-later", name: "GPT Added Later" },
    { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
  ]);
});

it("keeps literal wildcard rows and exact entries with the first duplicate's metadata", () => {
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        models: { "vllm/*": {}, "vllm/manual": {} },
        modelPolicy: { allow: ["vllm/*", "vllm/manual"] },
      },
    },
  } as unknown as OpenClawConfig;
  const nested = { provider: "vllm", id: "vllm/qwen-local", name: "Namespaced Qwen" };
  const catalog = [{ provider: "vllm", id: "qwen-local", name: "Qwen Local" }, nested];

  const policy = createModelVisibilityPolicy({
    cfg,
    catalog,
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
  });

  expect(
    policy.visibleCatalog({
      catalog: [],
      defaultVisibleCatalog: [...catalog, { ...nested, name: "Duplicate row" }],
    }),
  ).toEqual([...catalog, { provider: "vllm", id: "manual", name: "manual" }]);
});

it("keeps per-agent fallback overrides out of explicit selection", () => {
  const cfg = {
    agents: {
      defaults: {
        models: { "openai/gpt-4o": {} },
        modelPolicy: { allow: ["openai/gpt-4o"] },
        model: { primary: "openai/gpt-4o", fallbacks: ["google/gemini-3-pro"] },
      },
      entries: {
        coder: { model: { primary: "openai/gpt-4o", fallbacks: ["anthropic/claude-sonnet-4-6"] } },
      },
    },
  };

  const result = buildAllowedModelSet({
    cfg,
    catalog: [],
    defaultProvider: "openai",
    defaultModel: "gpt-4o",
    agentId: "coder",
  });

  expect(result.allowedKeys.has("openai/gpt-4o")).toBe(true);
  expect(result.allowedKeys.has("anthropic/claude-sonnet-4-6")).toBe(false);
  expect(result.allowedKeys.has("google/gemini-3.1-pro-preview")).toBe(false);
  expect(result.allowAny).toBe(false);
});

it.each([
  {
    name: "keeps deprecated catalog refs selectable",
    params: {
      cfg: {} as OpenClawConfig,
      catalog: [
        {
          provider: "openai",
          id: "gpt-5.5",
          name: "GPT-5.5",
          status: "deprecated" as const,
          replacedBy: "gpt-5.6",
        },
      ],
      raw: "openai/gpt-5.5",
      defaultProvider: "openai",
    },
    expected: { key: "openai/gpt-5.5", ref: { provider: "openai", model: "gpt-5.5" } },
  },
  {
    name: "strips trailing auth profile suffix before allowlist matching",
    params: {
      cfg: {
        agents: { defaults: { models: { "openai/@cf/openai/gpt-oss-20b": {} } } },
      } as unknown as OpenClawConfig,
      catalog: [],
      raw: "openai/@cf/openai/gpt-oss-20b@cf:default",
      defaultProvider: "anthropic",
    },
    expected: {
      key: "openai/@cf/openai/gpt-oss-20b",
      ref: { provider: "openai", model: "@cf/openai/gpt-oss-20b" },
    },
  },
  {
    name: "infers provider from allowlist for bare model ids to prevent prefix drift (#48369)",
    params: {
      cfg: createConfiguredModelRefConfig({
        modelEntries: {
          "openai/gpt-5.4": {},
          "opencode-go/kimi-k2.6": {},
          "opencode-go/glm-5": {},
        },
      }),
      catalog: [],
      raw: "kimi-k2.6",
      defaultProvider: "openai",
    },
    expected: {
      key: "opencode-go/kimi-k2.6",
      ref: { provider: "opencode-go", model: "kimi-k2.6" },
    },
  },
  {
    name: "resolves slash-form aliases before provider/model parsing",
    params: {
      cfg: createConfiguredModelRefConfig({
        modelEntries: { "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" } },
      }),
      catalog: [],
      raw: "xiaomi/mimo-v2-pro-mit",
      defaultProvider: "openai",
    },
    expected: {
      key: "openai/xiaomi/mimo-v2-pro-mit",
      ref: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
    },
  },
])("$name", ({ params, expected }) => {
  expect(resolveAllowedModelRef(params)).toEqual(expected);
});

it.each([false, true])("preserves provider identity with manifest normalization %s", (enabled) => {
  const params = {
    cfg: createConfiguredModelRefConfig({
      modelEntries: { "openai/gpt-4o-mini": { alias: "fixture-route/raw" } },
    }),
    defaultProvider: "openai",
    allowManifestNormalization: enabled,
    allowPluginNormalization: false,
  };
  const aliasIndex = buildModelAliasIndex(params);
  expect(resolveModelRefFromString({ ...params, raw: "fixture-route/raw", aliasIndex })).toEqual({
    ref: { provider: "fixture-route", model: enabled ? "canonical" : "raw" },
  });
});

it("strips profile suffix before alias resolution", () => {
  const index = {
    byAlias: new Map([
      ["kimi", { alias: "kimi", ref: { provider: "nvidia", model: "moonshotai/kimi-k2.5" } }],
    ]),
    byKey: new Map(),
  };

  const resolved = resolveModelRefFromString({
    raw: "kimi@nvidia:default",
    defaultProvider: "openai",
    aliasIndex: index,
  });
  expect(resolved?.ref).toEqual({ provider: "nvidia", model: "moonshotai/kimi-k2.5" });
  expect(resolved?.alias).toBe("kimi");
});

it("sanitizes control characters in providerless-model warnings", async () => {
  const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
  try {
    const cfg: Partial<OpenClawConfig> = createConfiguredModelRefConfig({
      primary: "\u001B[31mclaude-3-5-sonnet\nspoof",
    });

    const result = resolveConfiguredRefForTest(cfg as OpenClawConfig, {
      defaultProvider: "google",
      defaultModel: "gemini-pro",
    });

    expect(result).toEqual({
      provider: "google",
      model: "\u001B[31mclaude-3-5-sonnet\nspoof",
    });
    const warning = await warnLogs.findText('Falling back to "google/claude-3-5-sonnet"');
    expect(warning).toContain('Falling back to "google/claude-3-5-sonnet"');
    expect(warning).not.toContain("\u001B");
    expect(warning).not.toContain("\n");
  } finally {
    warnLogs.cleanup();
  }
});

it("infers a unique configured provider for bare default model strings", () => {
  const cfg = createConfiguredModelRefConfig({
    primary: "claude-opus-4-6",
    modelEntries: { "anthropic/claude-opus-4-6": {} },
  });
  expect(resolveConfiguredRefForTest(cfg)).toEqual({
    provider: "anthropic",
    model: "claude-opus-4-6",
  });
});

it("normalizes bare configured default model strings with manifest policies", () => {
  const cfg = {
    agents: { defaults: { model: { primary: "llama-fast" } } },
    models: { providers: { nvidia: { models: [{ id: "llama-fast" }] } } },
  } as unknown as OpenClawConfig;

  const result = resolveConfiguredRefForTest(cfg);

  expect(result).toEqual({ provider: "nvidia", model: "nvidia/canonical-fast" });
});

const nemotronProvider = {
  "nemotron-bolt": {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    models: [{ id: "nemotron-3-super-120b", name: "Nemotron" }],
  },
};

it.each([
  {
    name: "resolves a provider-qualified alias with a profile for a configured primary",
    primary: "nemotron-bolt/Fast@work",
    modelEntries: {
      "nemotron-bolt/nemotron-3-super-120b": { alias: "fast" },
      "openai/gpt-5.5": { alias: "fast" },
    },
    providers: nemotronProvider,
    expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
  },
  {
    name: "keeps a literal model before a same-provider alias",
    primary: "nemotron-bolt/fast",
    modelEntries: { "nemotron-bolt/nemotron-3-super-120b": { alias: "fast" } },
    providers: {
      "nemotron-bolt": {
        ...nemotronProvider["nemotron-bolt"],
        models: [...nemotronProvider["nemotron-bolt"].models, { id: "fast", name: "Fast" }],
      },
    },
    expected: { provider: "nemotron-bolt", model: "fast" },
  },
  {
    name: "keeps exact configured provider refs before slash-form alias values that point to them",
    primary: "nemotron-bolt/nemotron-3-super-120b",
    modelEntries: {
      "openai/nemotron-bolt/nemotron-3-super-120b": {
        alias: "nemotron-bolt/nemotron-3-super-120b",
      },
    },
    providers: nemotronProvider,
    expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
  },
  {
    name: "keeps built-in provider refs before bare alias values that point to them",
    primary: "anthropic/claude-opus-4-6",
    modelEntries: { opus: { alias: "anthropic/claude-opus-4-6" } },
    expected: { provider: "anthropic", model: "claude-opus-4-6" },
  },
  {
    name: "keeps a literal primary before a same-provider alias backed by a bare key",
    primary: "openai/friendly",
    modelEntries: { base: { alias: "openai/friendly" } },
    expected: { provider: "openai", model: "friendly" },
  },
  {
    name: "prefers slash-form aliases for configured default models",
    primary: "xiaomi/mimo-v2-pro-mit",
    modelEntries: { "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" } },
    expected: { provider: "openai", model: "xiaomi/mimo-v2-pro-mit" },
  },
  {
    name: "keeps a configured provider ahead of an exact auth-profile alias collision",
    primary: "nemotron-bolt/nemotron-3-super-120b@prod",
    modelEntries: {
      "openai/gpt-5.5": { alias: "nemotron-bolt/nemotron-3-super-120b@prod" },
    },
    providers: nemotronProvider,
    expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
  },
  {
    name: "keeps a configured provider ahead of a stripped auth-profile alias collision",
    primary: "nemotron-bolt/nemotron-3-super-120b@prod",
    modelEntries: {
      "openai/nemotron-bolt/nemotron-3-super-120b": {
        alias: "nemotron-bolt/nemotron-3-super-120b",
      },
    },
    providers: nemotronProvider,
    expected: { provider: "nemotron-bolt", model: "nemotron-3-super-120b" },
  },
])("$name", ({ primary, modelEntries, providers, expected }) => {
  const cfg = createConfiguredModelRefConfig({ primary, modelEntries, providers });
  const result = resolveConfiguredRefForTest(cfg);

  expect(result).toEqual(expected);
});

it("uses a configured custom provider when the default is only an empty overlay", () => {
  const cfg = createConfiguredModelRefConfig({
    providers: {
      openai: { baseUrl: "https://openai.example.com/v1", models: [] },
      "local-provider": {
        baseUrl: "http://127.0.0.1:9191/v1",
        models: [{ id: "local-good", name: "Local Good" }],
      },
    },
  });

  expect(resolveConfiguredRefForTest(cfg, { defaultModel: "missing-default-model" })).toEqual({
    provider: "local-provider",
    model: "local-good",
  });
});

it("normalizes retired nested Gemini ids in exact configured provider refs", () => {
  const cfg = createConfiguredModelRefConfig({
    primary: "kilocode/google/gemini-3-pro-preview",
    providers: {
      kilocode: {
        api: "openai-completions",
        baseUrl: "https://kilocode.test/v1",
        models: [{ id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro" }],
      },
    },
  });
  expect(
    resolveConfiguredRefForTest(cfg, {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      allowPluginNormalization: false,
    }),
  ).toEqual({ provider: "kilocode", model: "google/gemini-3.1-pro-preview" });
});

it("should fall back to hardcoded default when no custom providers have models", () => {
  const cfg = createConfiguredModelRefConfig({
    providers: { "empty-provider": { baseUrl: "https://empty-provider.example.com", models: [] } },
  });
  const result = resolveConfiguredRefForTest(cfg);
  expect(result).toEqual({ provider: "openai", model: "gpt-5.4" });
});

it("should warn when specified model cannot be resolved and falls back to default", async () => {
  const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
  try {
    const cfg: Partial<OpenClawConfig> = createConfiguredModelRefConfig({ primary: "openai/" });

    const result = resolveConfiguredRefForTest(cfg as OpenClawConfig);

    expect(result).toEqual({ provider: "openai", model: "gpt-5.4" });
    expect(
      await warnLogs.findText(
        'Model "openai/" could not be resolved. Falling back to default "openai/gpt-5.4".',
      ),
    ).toBeDefined();
  } finally {
    warnLogs.cleanup();
  }
});

it("resolves openrouter:auto through the canonical OpenRouter auto model", () => {
  const cfg = createConfiguredModelRefConfig({ primary: "openrouter:auto" });

  const result = resolveConfiguredRefForTest(cfg, {
    defaultProvider: "anthropic",
    defaultModel: "claude-sonnet-4-6",
  });

  expect(result).toEqual({ provider: "openrouter", model: "openrouter/auto" });
});

it("prefers an agent-configured OpenRouter free model over the global default", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "openrouter:free" },
        models: { "openrouter/global/default:free": {} },
      },
      entries: { worker: { models: { "openrouter/agent/preferred:free": {} } } },
    },
  } as OpenClawConfig;

  expect(resolveConfiguredRefForTest(cfg, { agentId: "worker" })).toEqual({
    provider: "openrouter",
    model: "agent/preferred:free",
  });
});

it("treats raw openrouter:free allowlist entries as allowed in the legacy resolver path", () => {
  const cfg = createConfiguredModelRefConfig({
    modelEntries: { "openrouter:free": {} },
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        models: [
          {
            id: "deepseek/deepseek-r1-0528:free",
            name: "DeepSeek R1 Free",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  });

  const catalog = [
    {
      provider: "openrouter",
      id: "deepseek/deepseek-r1-0528:free",
      name: "DeepSeek R1 Free",
    },
  ];

  expect(
    resolveAllowedModelRef({
      cfg,
      catalog,
      raw: "openrouter:free",
      defaultProvider: "anthropic",
    }),
  ).toEqual({
    ref: { provider: "openrouter", model: "deepseek/deepseek-r1-0528:free" },
    key: "openrouter/deepseek/deepseek-r1-0528:free",
  });
});

it("uses agent model metadata to resolve an inherited bare default", () => {
  const cfg = {
    agents: {
      defaults: { model: "claude-sonnet-4-6" },
      entries: {
        worker: { models: { "anthropic/claude-sonnet-4-6": { alias: "worker-sonnet" } } },
      },
    },
  } as OpenClawConfig;

  expect(resolveDefaultModelForAgent({ cfg, agentId: "worker" })).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  });
});

it("prefers the agent subagent model over default subagent and primary models", () => {
  const cfg = createSubagentSelectionConfig({
    defaultSubagentModel: "openai/gpt-5.4",
    agents: [
      {
        id: "research",
        model: { primary: "anthropic/claude-opus-4-6" },
        subagents: { model: "google/gemini-2.5-pro" },
      },
    ],
  });
  expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(
    "google/gemini-2.5-pro",
  );
});

it("keeps runtime policy attached to the configured default subagent model", () => {
  const cfg = {
    agents: {
      defaults: {
        subagents: { model: "anthropic/claude-sonnet-4-6" },
        models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } } },
      },
      list: [{ id: "research", model: "anthropic/claude-opus-4-7" }],
    },
  } as OpenClawConfig;

  const resolved = resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" });

  expect(resolved).toBe("anthropic/claude-sonnet-4-6");
  expect(
    resolveAgentHarnessPolicy({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      config: cfg,
    }),
  ).toEqual({ runtime: "claude-cli", runtimeSource: "model" });
});

it.each([
  {
    name: "resolves bare configured aliases with the target agent runtime default provider",
    config: {
      defaultPrimary: "openai/gpt-5.4",
      modelEntries: { "claude-opus-4-6": { alias: "opus" } },
      agents: [{ id: "research", model: "anthropic/claude-sonnet-4-6" }],
    },
    agentId: "research",
    modelOverride: "OPUS",
    expected: "anthropic/claude-opus-4-6",
  },
  {
    name: "resolves alias in configured subagent model",
    config: {
      modelEntries: { "openai/gpt-5.4": { alias: "gpt" } },
      defaultSubagentModel: "gpt",
    },
    agentId: "main",
    modelOverride: undefined,
    expected: "openai/gpt-5.4",
  },
  {
    name: "resolves profile-qualified aliases without treating the profile as model identity",
    config: { modelEntries: { "openai/gpt-5.6-luna": { alias: "luna" } } },
    agentId: "main",
    modelOverride: "luna@openai:test-profile",
    expected: "openai/gpt-5.6-luna@openai:test-profile",
  },
  {
    name: "resolves an alias configured only on the target agent",
    config: {
      modelEntries: { "openai/gpt-5.4": { alias: "global-gpt" } },
      agents: [
        {
          id: "research",
          models: { "anthropic/claude-opus-4-6": { alias: "research-opus" } },
        },
      ],
    },
    agentId: "research",
    modelOverride: "research-opus",
    expected: "anthropic/claude-opus-4-6",
  },
  {
    name: "falls back to runtime default when no override or config",
    config: {},
    agentId: "main",
    modelOverride: undefined,
    expected: "anthropic/claude-sonnet-4-6",
  },
])("$name", ({ config, agentId, modelOverride, expected }) => {
  const cfg = createSubagentSelectionConfig(config);

  expect(resolveSubagentSpawnModelSelection({ cfg, agentId, modelOverride })).toEqual({
    model: expected,
  });
});
