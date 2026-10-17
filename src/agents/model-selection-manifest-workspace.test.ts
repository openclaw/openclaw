import { beforeEach, expect, it, vi } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import {
  buildAllowedModelSet,
  buildConfiguredModelCatalog,
  buildModelAliasIndex,
  resolveConfiguredModelRef,
} from "./model-selection-shared.js";

const loadManifest = vi.hoisted(() => vi.fn());
const currentMetadata = vi.hoisted(() => vi.fn());
const workspaceDir = vi.hoisted(() => vi.fn());
const normalizeRuntime = vi.hoisted(() => vi.fn());

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: currentMetadata,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: loadManifest,
}));

vi.mock("../plugins/runtime-state.js", () => ({
  getActivePluginRegistryWorkspaceDirFromState: workspaceDir,
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeRuntime,
}));

const defaultNormalizationSnapshot = normalizationSnapshot({
  openai: { aliases: { entry: "middle", middle: "final" } },
});
const resolutionDefaults = { defaultProvider: "openai", defaultModel: "unused" };
const sonnetDefaults = { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-6" };

function normalizationSnapshot(
  providers: NonNullable<PluginManifestRecord["modelIdNormalization"]>["providers"],
) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: "workspace-model-normalizer", modelIdNormalization: { providers } }],
  });
}

function createCatalogConfig(): OpenClawConfig {
  return {
    models: { providers: { custom: { models: [{ id: "fast-model" }] } } },
  } as unknown as OpenClawConfig;
}

function modelConfig(
  model: AgentDefaultsConfig["model"],
  models?: AgentDefaultsConfig["models"],
): OpenClawConfig {
  return { agents: { defaults: { model, models } } };
}

function expectResolved(
  cfg: OpenClawConfig,
  model: string,
  options: Partial<Omit<Parameters<typeof resolveConfiguredModelRef>[0], "cfg">> = {},
  provider = "openai",
) {
  expect(resolveConfiguredModelRef({ cfg, ...resolutionDefaults, ...options })).toEqual({
    provider,
    model,
  });
}

function expectNoMetadataLoads() {
  expect(currentMetadata).not.toHaveBeenCalled();
  expect(loadManifest).not.toHaveBeenCalled();
}

beforeEach(() => {
  currentMetadata.mockReset().mockReturnValue(undefined);
  workspaceDir.mockReset();
  normalizeRuntime.mockReset();
  loadManifest
    .mockReset()
    .mockReturnValue(normalizationSnapshot({ custom: { prefixWhenBare: "workspace-custom" } }));
});

it("does not reuse workspace manifest policies without a workspace context", () => {
  const cfg = createCatalogConfig();

  expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
    { provider: "custom", id: "fast-model" },
  ]);
  expect(currentMetadata).toHaveBeenCalledWith({
    config: cfg,
    env: process.env,
  });
  expect(loadManifest.mock.calls.length).toBe(0);
});

it("builds configured catalog facts once when resolving allowed models", () => {
  currentMetadata.mockReturnValue(createPluginMetadataSnapshotFixture());
  const cfg = createCatalogConfig();

  expect(
    buildAllowedModelSet({
      cfg,
      catalog: [],
      defaultProvider: "custom",
    }).allowedCatalog,
  ).toMatchObject([{ provider: "custom", id: "fast-model" }]);
  expect(currentMetadata).toHaveBeenCalledTimes(1);
  expect(loadManifest.mock.calls.length).toBe(0);
});

it("does not load manifest metadata for wildcard-only configured model aliases", () => {
  const aliases = buildModelAliasIndex({
    cfg: modelConfig(undefined, { "anthropic/*": {} }),
    defaultProvider: "anthropic",
  });
  expect(aliases).toMatchObject({ byAlias: { size: 0 }, byKey: { size: 0 } });
  expectNoMetadataLoads();
});

it("resolves selected-agent default-provider aliases without cold manifest discovery", () => {
  const cfg = {
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: {
        ops: {
          model: { primary: "Operations" },
          models: { "openai/ops": { alias: "Operations" } },
        },
      },
    },
  } as unknown as OpenClawConfig;

  expectResolved(cfg, "ops", { agentId: "ops", defaultModel: "gpt-5.6-sol" });
  expect(loadManifest.mock.calls.length).toBe(0);
  expect(normalizeRuntime.mock.calls.length).toBe(0);
});

it("preserves workspace manifest policy for default-provider aliases", () => {
  workspaceDir.mockReturnValue("/workspace/a");
  loadManifest.mockReturnValue(
    normalizationSnapshot({ openai: { aliases: { ops: "workspace-ops" } } }),
  );
  const cfg = modelConfig(undefined, { "openai/ops": { alias: "Operations" } });

  expect(
    buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
  ).toEqual({ provider: "openai", model: "workspace-ops" });
  expect(loadManifest.mock.calls.length).toBe(1);
  expect(loadManifest.mock.calls[0]?.[0]?.workspaceDir).toBe("/workspace/a");
});

it("does not renormalize the explicit selection", () => {
  expectResolved(modelConfig({ primary: "openai/entry" }), "middle", {
    manifestPlugins: defaultNormalizationSnapshot,
    allowPluginNormalization: false,
  });
});

it("honors captured runtime-only normalization flags", () => {
  normalizeRuntime.mockImplementation(
    ({ context }: { context: { modelId: string } }) => `runtime-${context.modelId}`,
  );
  expectResolved(modelConfig("entry"), "runtime-entry", {
    manifestPlugins: defaultNormalizationSnapshot,
    allowManifestNormalization: false,
    allowPluginNormalization: true,
  });
  expect(normalizeRuntime).toHaveBeenCalledTimes(1);
  expectNoMetadataLoads();
});

it("reuses metadata captured during unsuccessful provider inference", () => {
  loadManifest.mockReturnValue(defaultNormalizationSnapshot);
  expectResolved(modelConfig("entry", { "custom/unrelated": {} }), "middle", {
    allowPluginNormalization: false,
  });
  expect(loadManifest).toHaveBeenCalledTimes(1);
});

it("preserves the configured native API owner for a captured bare default", () => {
  normalizeRuntime.mockReturnValue("wrong-runtime-model");
  expectResolved(
    {
      ...modelConfig("entry@work"),
      models: {
        providers: {
          openai: { api: "ollama", baseUrl: "https://fixture.invalid", models: [] },
        },
      },
    },
    "middle",
    { manifestPlugins: defaultNormalizationSnapshot },
  );
  expect(normalizeRuntime).not.toHaveBeenCalled();
});

it.each([
  { primary: "entry@", expected: "entry@" },
  { primary: "/", expected: "unused" },
])("preserves captured malformed '$primary' parsing", ({ primary, expected }) => {
  expectResolved(modelConfig({ primary }), expected, {
    manifestPlugins: [],
    allowPluginNormalization: false,
  });
  expectNoMetadataLoads();
});

it.each([
  {
    cfg: modelConfig({ primary: "sonnet-4.6" }),
    expected: { provider: "anthropic", model: "claude-sonnet-4-6" },
  },
  {
    cfg: {
      ...modelConfig({ primary: "gpt-5.5" }),
      models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
    } as unknown as OpenClawConfig,
    expected: { provider: "openai", model: "gpt-5.5" },
  },
])(
  "does not load manifest metadata for statically resolved primary models: $expected.model",
  ({ cfg, expected }) => {
    expectResolved(cfg, expected.model, sonnetDefaults, expected.provider);
    expectNoMetadataLoads();
  },
);

it("uses manifest-normalized configured refs to infer providers for bare defaults", () => {
  loadManifest.mockReturnValue(
    normalizationSnapshot({ anthropic: { aliases: { "sonnet-4.6": "claude-sonnet-4-6" } } }),
  );
  const cfg = modelConfig({ primary: "claude-sonnet-4-6" }, { "anthropic/sonnet-4.6": {} });

  expectResolved(cfg, "claude-sonnet-4-6", { defaultModel: "gpt-5.4" }, "anthropic");
  expect(loadManifest).toHaveBeenCalledTimes(1);
});

it("reuses resolved manifest plugins while resolving direct primary models", () => {
  loadManifest.mockReturnValue(
    normalizationSnapshot({
      anthropic: { aliases: { "sonnet-4.6": "claude-sonnet-4-6" } },
      openrouter: { prefixWhenBare: "openrouter" },
    }),
  );
  const cfg = modelConfig(
    { primary: "openrouter:auto" },
    { "anthropic/sonnet-4.6": { alias: "sonnet" } },
  );

  expectResolved(cfg, "openrouter/auto", sonnetDefaults, "openrouter");
  expect(loadManifest).toHaveBeenCalledTimes(1);
});
