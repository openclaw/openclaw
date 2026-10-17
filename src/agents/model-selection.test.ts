import { afterEach, it, expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
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

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type Entries = NonNullable<OpenClawConfig["agents"]>["entries"];
const ref = (provider: string, model: string) => ({ provider, model });
const row = (provider: string, id: string, name = id): ModelCatalogEntry => ({
  provider,
  id,
  name,
});
const aliases = (entries: Record<string, string>) =>
  Object.fromEntries(Object.entries(entries).map(([key, alias]) => [key, { alias }]));
function config(defaults: Defaults = {}, entries?: Entries, providers?: Record<string, unknown>) {
  return {
    agents: { defaults, ...(entries ? { entries } : {}) },
    ...(providers ? { models: { providers } } : {}),
  } as unknown as OpenClawConfig;
}
function allowed(
  cfg: OpenClawConfig,
  catalog: ModelCatalogEntry[] = [],
  options: Partial<Omit<Parameters<typeof buildAllowedModelSet>[0], "cfg" | "catalog">> = {},
) {
  return buildAllowedModelSet({ cfg, catalog, defaultProvider: "custom", ...options });
}

function customPolicy(allow: string[], catalog: ModelCatalogEntry[]) {
  const providers = {
    custom: { api: "openai-completions", baseUrl: "https://custom.example/v1", models: [] },
  };
  return createModelVisibilityPolicy({
    cfg: config({ modelPolicy: { allow } }, undefined, providers),
    catalog,
    defaultProvider: "custom",
  });
}

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

function subagentConfig(defaults: Defaults = {}, entries?: Entries) {
  return config({ model: { primary: "anthropic/claude-sonnet-4-6" }, ...defaults }, entries);
}

function providerModels(providers: Record<string, readonly string[]>) {
  return Object.fromEntries(
    Object.entries(providers).map(([provider, ids]) => [
      provider,
      { models: ids.map((id) => ({ id })) },
    ]),
  );
}

function resolveConfiguredRefForTest(
  cfg: OpenClawConfig,
  options: Partial<Omit<Parameters<typeof resolveConfiguredModelRef>[0], "cfg">> = {},
) {
  return resolveConfiguredModelRef({
    cfg,
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
  [
    "splits legacy combined refs",
    { overrideModel: "ollama-beelink2/qwen2.5-coder:7b" },
    { provider: "ollama-beelink2", model: "qwen2.5-coder:7b" },
  ],
  [
    "preserves explicit runtime provider for vendor-prefixed ids",
    { runtimeProvider: "openrouter", runtimeModel: "anthropic/claude-haiku-4.5" },
    { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
  ],
  [
    "ignores malformed persisted metadata instead of throwing",
    {
      runtimeProvider: { provider: "openai" },
      runtimeModel: false,
      overrideProvider: ["openrouter"],
      overrideModel: 123,
    },
    null,
  ],
] as const)("%s", (_name, params, expected) => {
  expect(resolvePersistedSelectedModelRef({ defaultProvider: "anthropic", ...params })).toEqual(
    expected,
  );
});

it.each([
  [
    "prefers unique case-insensitive agent match over collisions",
    ["anthropic/SHARED-MODEL"],
    "anthropic",
  ],
  [
    "keeps ambiguous agent matches unresolved",
    ["anthropic/shared-model", "minimax/shared-model"],
    undefined,
  ],
] as const)("%s", (_name, agentModels, expected) => {
  const cfg = config(
    { models: { "openai/shared-model": {} } },
    { worker: { models: Object.fromEntries(agentModels.map((key) => [key, {}])) } },
    agentModels.length === 1 ? { minimax: { models: [{ id: "shared-model" }] } } : undefined,
  );
  expect(
    inferUniqueProviderFromConfiguredModels({ cfg, agentId: "worker", model: "shared-model" }),
  ).toBe(expected);
});

it.each(["defaults", "agent", "configured catalog", "catalog"] as const)(
  "bare provider inference from %s",
  (scope) => {
    const rows = [row("first", "model"), row("second", "MODEL"), row("third", "Model")];
    const models = Object.fromEntries(rows.map((entry) => [`${entry.provider}/${entry.id}`, {}]));
    const cfg: OpenClawConfig =
      scope === "defaults"
        ? config({ models })
        : scope === "agent"
          ? { agents: { entries: { worker: { models } } } }
          : scope === "configured catalog"
            ? config(
                {},
                undefined,
                providerModels(
                  Object.fromEntries(rows.map((entry) => [entry.provider, [entry.id]])),
                ),
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
  },
);

it("disables the global alias with an explicit empty agent alias", () => {
  const cfg = config(
    { models: aliases({ "openai/gpt-5.6-luna": "global-luna" }) },
    { worker: { models: aliases({ "openai/gpt-5.6-luna": "" }) } },
  );
  const index = buildModelAliasIndex({ cfg, agentId: "worker", defaultProvider: "openai" });
  expect(index.byKey.get("openai/gpt-5.6-luna")).toBeUndefined();
  expect(index.byAlias.get("global-luna")).toBeUndefined();
});

it("preserves another model's provider-qualified duplicate alias during replacement", () => {
  const cfg = config(
    { models: aliases({ "openai/gpt-a": "shared", "openai/gpt-b": "shared" }) },
    { worker: { models: aliases({ "openai/gpt-a": "worker-a" }) } },
  );

  const index = buildModelAliasIndex({ cfg, agentId: "worker", defaultProvider: "openai" });

  expect(index.byProviderAlias?.get("openai/shared")?.ref).toEqual(ref("openai", "gpt-b"));
  expect(index.byProviderAlias?.get("openai/worker-a")?.ref).toEqual(ref("openai", "gpt-a"));
});

it.each([
  ["absent", true],
  ["reversed", false],
  ["nested-only", true],
] as const)(
  "keeps literal provider-prefixed models visible (%s catalog; reversed policy=%s)",
  (catalogOrder, reversePolicy) => {
    const rows = [row("custom", "model"), row("custom", "custom/model")];
    const allow = rows.map((entry) => `custom/${entry.id}`);
    if (reversePolicy) {
      allow.reverse();
    }
    const catalogRows =
      catalogOrder === "reversed" || catalogOrder === "nested-only" ? rows.toReversed() : rows;
    const availableRows = catalogOrder.endsWith("-only") ? catalogRows.slice(0, 1) : catalogRows;
    const policy = customPolicy(allow, [
      ...(catalogOrder === "absent" ? [] : availableRows),
      row("other", "model", "Excluded"),
    ]);

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
    const catalog = [row("custom", id)];
    const policy = customPolicy([`custom/${id}`, `custom/${missing}`], catalog);

    expect(policy.visibleCatalog({ catalog: [], defaultVisibleCatalog: [] })).toEqual([
      ...catalog,
      ...(expectSynthetic ? [row("custom", missing)] : []),
    ]);
  },
);

it("keeps case-insensitive visibility inside the exact provider namespace", () => {
  const result = allowed(
    config({ modelPolicy: { allow: ["custom/team/Reader", "custom/READER"] } }),
    [
      row("custom", "team/Reader", "Nested model"),
      row("custom/team", "Reader", "Namespaced provider"),
      row("custom", "Reader", "Uppercase"),
      row("custom", "reader", "Lowercase"),
      row("other", "READER", "Other provider"),
    ],
  );

  expect(result.allowedCatalog.map(({ provider, id }) => [provider, id])).toEqual([
    ["custom", "team/Reader"],
    ["custom", "Reader"],
    ["custom", "reader"],
    ["custom", "READER"],
  ]);
});

it("keeps metadata on custom/model and custom/custom/model", () => {
  const rows = [
    { id: "model", name: "Primary", contextWindow: 32_000, reasoning: false, input: ["text"] },
    {
      id: "custom/model",
      name: "Configured sibling",
      contextWindow: 128_000,
      reasoning: true,
      input: ["text", "image"],
    },
  ] satisfies Array<Partial<ModelDefinitionConfig> & { id: string }>;
  for (const configuredRows of [rows, rows.toReversed()]) {
    const cfg = config({}, undefined, {
      custom: {
        baseUrl: "https://configured.example/v1",
        models: structuredClone(configuredRows),
      },
    });
    const result = allowed(cfg, [
      {
        ...row("custom", "model", "Runtime primary"),
        api: "openai-responses",
        baseUrl: "https://captured.example/v1",
      },
    ]);

    expect(result.allowedCatalog).toMatchObject([
      {
        ...rows[0],
        provider: "custom",
        api: "openai-responses",
        baseUrl: "https://captured.example/v1",
      },
      { ...rows[1], provider: "custom" },
    ]);
  }
});

it("keeps synthetic entries sparse when configured metadata belongs to custom/model", () => {
  const result = allowed(
    config(
      {
        models: aliases({ "custom/model": "Selected alias" }),
        modelPolicy: { allow: ["custom/model"] },
      },
      undefined,
      {
        custom: {
          baseUrl: "https://configured.example/v1",
          models: [
            {
              id: "custom/model",
              name: "Unrelated configured name",
              contextWindow: 128_000,
              reasoning: true,
              input: ["text", "image"],
              params: { temperature: 0.5 },
            },
          ],
        },
      },
    ),
  );

  expect(result.allowedCatalog).toEqual([{ ...row("custom", "model"), alias: "Selected alias" }]);
});

it("exposes wildcard allow and visible catalog behavior through one policy", () => {
  const cfg = config({
    models: { "openai/*": {}, "anthropic/claude-sonnet-4-6": {} },
    modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] },
  });

  const catalog = [
    row("anthropic", "claude-sonnet-4-6", "Claude Sonnet"),
    row("openai", "gpt-added-later", "GPT Added Later"),
    row("vllm", "qwen-local", "Qwen Local"),
  ];
  const policy = createModelVisibilityPolicy({
    cfg,
    catalog: structuredClone(catalog),
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
      defaultVisibleCatalog: structuredClone(catalog.slice(1)),
    }),
  ).toEqual([catalog[1], catalog[0]]);
});

it("keeps literal wildcard rows and exact entries with the first duplicate's metadata", () => {
  const cfg = config({
    models: { "vllm/*": {}, "vllm/manual": {} },
    modelPolicy: { allow: ["vllm/*", "vllm/manual"] },
  });
  const nested = row("vllm", "vllm/qwen-local", "Namespaced Qwen");
  const catalog = [row("vllm", "qwen-local", "Qwen Local"), nested];

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
  ).toEqual([...catalog, row("vllm", "manual")]);
});

it("keeps per-agent fallback overrides out of explicit selection", () => {
  const cfg = config(
    {
      models: { "openai/gpt-4o": {} },
      modelPolicy: { allow: ["openai/gpt-4o"] },
      model: { primary: "openai/gpt-4o", fallbacks: ["google/gemini-3-pro"] },
    },
    {
      coder: { model: { primary: "openai/gpt-4o", fallbacks: ["anthropic/claude-sonnet-4-6"] } },
    },
  );

  const result = allowed(cfg, [], {
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
  [
    "strips trailing auth profile suffix",
    "openai/@cf/openai/gpt-oss-20b@cf:default",
    config({ models: { "openai/@cf/openai/gpt-oss-20b": {} } }),
    "anthropic",
    ref("openai", "@cf/openai/gpt-oss-20b"),
    [],
  ],
  [
    "infers bare ids from the allowlist (#48369)",
    "kimi-k2.6",
    config({
      models: { "openai/gpt-5.4": {}, "opencode-go/kimi-k2.6": {}, "opencode-go/glm-5": {} },
    }),
    "openai",
    ref("opencode-go", "kimi-k2.6"),
    [],
  ],
  [
    "resolves slash-form aliases before parsing",
    "xiaomi/mimo-v2-pro-mit",
    config({ models: aliases({ "openai/xiaomi/mimo-v2-pro-mit": "xiaomi/mimo-v2-pro-mit" }) }),
    "openai",
    ref("openai", "xiaomi/mimo-v2-pro-mit"),
    [],
  ],
  [
    "allows raw openrouter:free in the legacy resolver path",
    "openrouter:free",
    config({ models: { "openrouter:free": {} } }, undefined, {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        models: [{ id: "deepseek/deepseek-r1-0528:free" }],
      },
    }),
    "anthropic",
    ref("openrouter", "deepseek/deepseek-r1-0528:free"),
    [row("openrouter", "deepseek/deepseek-r1-0528:free", "DeepSeek R1 Free")],
  ],
] as const)("%s", (_name, raw, cfg, defaultProvider, expected, catalog) => {
  expect(resolveAllowedModelRef({ cfg, catalog: [...catalog], raw, defaultProvider })).toEqual({
    key: `${expected.provider}/${expected.model}`,
    ref: expected,
  });
});

it.each([false, true])("preserves provider identity with manifest normalization %s", (enabled) => {
  const params = {
    cfg: config({ models: aliases({ "openai/gpt-4o-mini": "fixture-route/raw" }) }),
    defaultProvider: "openai",
    allowManifestNormalization: enabled,
    allowPluginNormalization: false,
  };
  const aliasIndex = buildModelAliasIndex(params);
  expect(resolveModelRefFromString({ ...params, raw: "fixture-route/raw", aliasIndex })).toEqual({
    ref: { provider: "fixture-route", model: enabled ? "canonical" : "raw" },
  });
});

it.each([
  [
    "sanitizes control characters in providerless-model warnings",
    "\u001B[31mclaude-3-5-sonnet\nspoof",
    { defaultProvider: "google", defaultModel: "gemini-pro" },
    ref("google", "\u001B[31mclaude-3-5-sonnet\nspoof"),
    'Falling back to "google/claude-3-5-sonnet"',
  ],
  [
    "warns when an unresolved model falls back to default",
    "openai/",
    {},
    ref("openai", "gpt-5.4"),
    'Model "openai/" could not be resolved. Falling back to default "openai/gpt-5.4".',
  ],
] as const)("%s", async (_name, primary, options, expected, warningText) => {
  const warnLogs = createWarnLogCapture("openclaw-model-selection-test");
  try {
    expect(resolveConfiguredRefForTest(config({ model: { primary } }), options)).toEqual(expected);
    const warning = await warnLogs.findText(warningText);
    expect(warning).toContain(warningText);
    if (primary.includes("\u001B")) {
      expect(warning).not.toContain("\u001B");
      expect(warning).not.toContain("\n");
    }
  } finally {
    warnLogs.cleanup();
  }
});

it("normalizes bare configured default model strings with manifest policies", () => {
  const cfg = config({ model: { primary: "llama-fast" } }, undefined, {
    nvidia: { models: [{ id: "llama-fast" }] },
  });
  expect(resolveConfiguredRefForTest(cfg)).toEqual(ref("nvidia", "nvidia/canonical-fast"));
});

const nemotronProvider = {
  "nemotron-bolt": {
    api: "openai-completions",
    models: [{ id: "nemotron-3-super-120b" }],
  },
};

it.each([
  [
    "resolves a provider-qualified alias with a profile for a configured primary",
    "nemotron-bolt/Fast@work",
    {
      "nemotron-bolt/nemotron-3-super-120b": { alias: "fast" },
      "openai/gpt-5.5": { alias: "fast" },
    },
    ref("nemotron-bolt", "nemotron-3-super-120b"),
    nemotronProvider,
  ],
  [
    "keeps a literal model before a same-provider alias",
    "nemotron-bolt/fast",
    { "nemotron-bolt/nemotron-3-super-120b": { alias: "fast" } },
    ref("nemotron-bolt", "fast"),
    {
      "nemotron-bolt": {
        ...nemotronProvider["nemotron-bolt"],
        models: [...nemotronProvider["nemotron-bolt"].models, { id: "fast" }],
      },
    },
  ],
  [
    "keeps built-in provider refs before bare alias values that point to them",
    "anthropic/claude-opus-4-6",
    { opus: { alias: "anthropic/claude-opus-4-6" } },
    ref("anthropic", "claude-opus-4-6"),
    undefined,
  ],
  [
    "keeps a literal primary before a same-provider alias backed by a bare key",
    "openai/friendly",
    { base: { alias: "openai/friendly" } },
    ref("openai", "friendly"),
    undefined,
  ],
  [
    "prefers slash-form aliases for configured default models",
    "xiaomi/mimo-v2-pro-mit",
    { "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" } },
    ref("openai", "xiaomi/mimo-v2-pro-mit"),
    undefined,
  ],
] as const)("%s", (_name, primary, models, expected, providers) => {
  const cfg = config({ model: { primary }, models }, undefined, providers);
  expect(resolveConfiguredRefForTest(cfg)).toEqual(expected);
});

it.each([
  [
    "custom provider behind empty default overlay",
    { openai: [], "local-provider": ["local-good"] },
    "missing-default-model",
    ref("local-provider", "local-good"),
  ],
  ["hardcoded fallback", { "empty-provider": [] }, "gpt-5.4", ref("openai", "gpt-5.4")],
] as const)("resolves %s", (_name, providers, defaultModel, expected) => {
  const cfg = config({}, undefined, providerModels(providers));
  expect(resolveConfiguredRefForTest(cfg, { defaultModel })).toEqual(expected);
});

it("normalizes retired nested Gemini ids in exact configured provider refs", () => {
  const cfg = config({ model: { primary: "kilocode/google/gemini-3-pro-preview" } }, undefined, {
    kilocode: {
      api: "openai-completions",
      baseUrl: "https://kilocode.test/v1",
      models: [{ id: "google/gemini-3-pro-preview", name: "Gemini 3 Pro" }],
    },
  });
  expect(
    resolveConfiguredRefForTest(cfg, {
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      allowPluginNormalization: false,
    }),
  ).toEqual(ref("kilocode", "google/gemini-3.1-pro-preview"));
});

it("prefers an agent-configured OpenRouter free model over the global default", () => {
  const cfg = config(
    {
      model: { primary: "openrouter:free" },
      models: { "openrouter/global/default:free": {} },
    },
    { worker: { models: { "openrouter/agent/preferred:free": {} } } },
  );

  expect(resolveConfiguredRefForTest(cfg, { agentId: "worker" })).toEqual(
    ref("openrouter", "agent/preferred:free"),
  );
});

it("uses agent model metadata to resolve an inherited bare default", () => {
  const cfg = config(
    { model: "claude-sonnet-4-6" },
    { worker: { models: aliases({ "anthropic/claude-sonnet-4-6": "worker-sonnet" }) } },
  );

  expect(resolveDefaultModelForAgent({ cfg, agentId: "worker" })).toEqual(
    ref("anthropic", "claude-sonnet-4-6"),
  );
});

it("prefers the agent subagent model over default subagent and primary models", () => {
  const cfg = subagentConfig(
    { subagents: { model: "openai/gpt-5.4" } },
    {
      research: {
        model: { primary: "anthropic/claude-opus-4-6" },
        subagents: { model: "google/gemini-2.5-pro" },
      },
    },
  );
  expect(resolveSubagentConfiguredModelSelection({ cfg, agentId: "research" })).toBe(
    "google/gemini-2.5-pro",
  );
});

it("keeps runtime policy attached to the configured default subagent model", () => {
  const cfg = config(
    {
      subagents: { model: "anthropic/claude-sonnet-4-6" },
      models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } } },
    },
    { research: { model: "anthropic/claude-opus-4-7" } },
  );

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
    name: "resolves bare aliases with the target agent's provider",
    cfg: subagentConfig(
      { model: { primary: "openai/gpt-5.4" }, models: aliases({ "claude-opus-4-6": "opus" }) },
      { research: { model: "anthropic/claude-sonnet-4-6" } },
    ),
    agentId: "research",
    modelOverride: "OPUS",
    expected: "anthropic/claude-opus-4-6",
  },
  {
    name: "resolves alias in configured subagent model",
    cfg: subagentConfig({
      models: aliases({ "openai/gpt-5.4": "gpt" }),
      subagents: { model: "gpt" },
    }),
    expected: "openai/gpt-5.4",
  },
  {
    name: "keeps the profile suffix outside alias identity",
    cfg: subagentConfig({ models: aliases({ "openai/gpt-5.6-luna": "luna" }) }),
    modelOverride: "luna@openai:test-profile",
    expected: "openai/gpt-5.6-luna@openai:test-profile",
  },
  {
    name: "resolves an alias configured only on the target agent",
    cfg: subagentConfig(
      { models: aliases({ "openai/gpt-5.4": "global-gpt" }) },
      { research: { models: aliases({ "anthropic/claude-opus-4-6": "research-opus" }) } },
    ),
    agentId: "research",
    modelOverride: "research-opus",
    expected: "anthropic/claude-opus-4-6",
  },
  {
    name: "falls back to runtime default when no override or config",
    cfg: subagentConfig(),
    expected: "anthropic/claude-sonnet-4-6",
  },
])("$name", ({ cfg, agentId = "main", modelOverride, expected }) => {
  expect(resolveSubagentSpawnModelSelection({ cfg, agentId, modelOverride })).toEqual({
    model: expected,
  });
});

it("excludes typed-only rows from conversational selection while retaining dual-capability rows", () => {
  const chat = row("fixture", "chat", "Chat");
  const typed = { ...row("fixture", "typed", "Typed"), inference: { chat: false as const } };
  const dual = { ...row("fixture", "dual", "Dual"), inference: { chat: true as const } };
  const result = allowed({}, [chat, typed, dual], { defaultProvider: "fixture" });
  expect(result.allowedCatalog).toEqual([chat, dual]);
  expect(result.allowedKeys.has("fixture/typed")).toBe(false);
});
