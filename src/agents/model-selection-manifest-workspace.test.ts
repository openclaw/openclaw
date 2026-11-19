// Verifies configured model selection uses manifest policy only in scoped contexts.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const loadManifestMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const getCurrentPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryWorkspaceDirFromStateMock = vi.hoisted(() => vi.fn());
const normalizeProviderModelIdWithRuntimeMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: getCurrentPluginMetadataSnapshotMock,
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: loadManifestMetadataSnapshotMock,
}));

vi.mock("../plugins/runtime-state.js", () => ({
  getActivePluginRegistryWorkspaceDirFromState: getActivePluginRegistryWorkspaceDirFromStateMock,
}));

vi.mock("./provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: normalizeProviderModelIdWithRuntimeMock,
}));

function normalizationSnapshot(
  providers: NonNullable<PluginManifestRecord["modelIdNormalization"]>["providers"],
) {
  return createPluginMetadataSnapshotFixture({
    plugins: [{ id: "workspace-model-normalizer", modelIdNormalization: { providers } }],
  });
}
const defaultNormalizationSnapshot = normalizationSnapshot({
  openai: { aliases: { entry: "middle", middle: "final" } },
});

function createCatalogConfig(): OpenClawConfig {
  return {
    models: { providers: { custom: { models: [{ id: "fast-model" }] } } },
  } as unknown as OpenClawConfig;
}

type Selection = Parameters<typeof resolveConfiguredModelRef>[0];
function expectConfiguredModelRef(params: Partial<Selection> & Pick<Selection, "cfg">) {
  return expect(
    resolveConfiguredModelRef({
      defaultProvider: "openai",
      defaultModel: "unused",
      ...params,
    }),
  );
}

function modelConfig(
  model: AgentDefaultsConfig["model"],
  models?: AgentDefaultsConfig["models"],
): OpenClawConfig {
  return { agents: { defaults: { model, models } } };
}

function expectNoMetadataLoads() {
  expect(getCurrentPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
}

describe("configured model manifest workspace scope", () => {
  beforeEach(() => {
    for (const mock of [
      loadManifestMetadataSnapshotMock,
      getCurrentPluginMetadataSnapshotMock,
      getActivePluginRegistryWorkspaceDirFromStateMock,
      normalizeProviderModelIdWithRuntimeMock,
    ]) {
      mock.mockReset();
    }
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({ custom: { prefixWhenBare: "workspace-custom" } }),
    );
  });

  it("does not reuse workspace manifest policies without a workspace context", () => {
    const cfg = createCatalogConfig();
    expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
      { provider: "custom", id: "fast-model" },
    ]);
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("builds configured catalog facts once when resolving allowed models", () => {
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(createPluginMetadataSnapshotFixture());
    const cfg = createCatalogConfig();

    expect(
      buildAllowedModelSet({
        cfg,
        catalog: [],
        defaultProvider: "custom",
      }).allowedCatalog,
    ).toMatchObject([{ provider: "custom", id: "fast-model" }]);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledTimes(1);
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("does not load manifest metadata for wildcard-only configured model aliases", () => {
    const cfg = modelConfig(undefined, { "anthropic/*": {} });
    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });

    expect([aliases.byAlias.size, aliases.byKey.size]).toEqual([0, 0]);
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

    expectConfiguredModelRef({
      cfg,
      agentId: "ops",
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-sol",
    }).toEqual({ provider: "openai", model: "ops" });
    expect(loadManifestMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it("preserves workspace manifest policy for default-provider aliases", () => {
    getActivePluginRegistryWorkspaceDirFromStateMock.mockReturnValue("/workspace/a");
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({ openai: { aliases: { ops: "workspace-ops" } } }),
    );
    const cfg = modelConfig(undefined, { "openai/ops": { alias: "Operations" } });

    expect(
      buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
    ).toEqual({ provider: "openai", model: "workspace-ops" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/workspace/a" }),
    );
  });

  it.each([
    ["openai/entry", "middle"],
    ["entry@", "entry@"],
    ["/", "unused"],
  ])("normalizes captured selection %s once", (primary, model) => {
    expectConfiguredModelRef({
      cfg: modelConfig({ primary }),
      manifestPlugins: defaultNormalizationSnapshot,
      allowPluginNormalization: false,
    }).toEqual({ provider: "openai", model });
    expectNoMetadataLoads();
  });

  it("honors captured normalization flags (manifest=false, runtime=true)", () => {
    normalizeProviderModelIdWithRuntimeMock.mockImplementation(
      ({ context }: { context: { modelId: string } }) => `runtime-${context.modelId}`,
    );
    expectConfiguredModelRef({
      cfg: modelConfig("entry"),
      manifestPlugins: defaultNormalizationSnapshot,
      allowManifestNormalization: false,
      allowPluginNormalization: true,
    }).toEqual({ provider: "openai", model: "runtime-entry" });
    expectNoMetadataLoads();
  });

  it("preserves the configured native API owner for a captured bare default", () => {
    normalizeProviderModelIdWithRuntimeMock.mockReturnValue("wrong-runtime-model");
    expectConfiguredModelRef({
      cfg: {
        ...modelConfig("entry@work"),
        models: {
          providers: { openai: { api: "ollama", baseUrl: "https://fixture.invalid", models: [] } },
        },
      },
      manifestPlugins: defaultNormalizationSnapshot,
    }).toEqual({ provider: "openai", model: "middle" });
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it.each([
    [modelConfig({ primary: "sonnet-4.6" }), "anthropic", "claude-sonnet-4-6"],
    [
      {
        ...modelConfig({ primary: "gpt-5.5" }),
        models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
      } as unknown as OpenClawConfig,
      "openai",
      "gpt-5.5",
    ],
  ] as const)("resolves static %j without metadata", (cfg, provider, model) => {
    expectConfiguredModelRef({
      cfg,
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
    }).toEqual({ provider, model });
    expectNoMetadataLoads();
  });

  it.each([
    ["entry", { "custom/unrelated": {} }, "openai", "middle"],
    ["claude-sonnet-4-6", { "anthropic/sonnet-4.6": {} }, "anthropic", "claude-sonnet-4-6"],
    [
      "openrouter:auto",
      { "anthropic/sonnet-4.6": { alias: "sonnet" } },
      "openrouter",
      "openrouter/auto",
    ],
  ] as const)("reuses discovered metadata for %s", (primary, models, provider, model) => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({
        openai: { aliases: { entry: "middle", middle: "final" } },
        anthropic: { aliases: { "sonnet-4.6": "claude-sonnet-4-6" } },
        openrouter: { prefixWhenBare: "openrouter" },
      }),
    );
    expectConfiguredModelRef({
      cfg: modelConfig({ primary }, models),
      defaultProvider: primary === "openrouter:auto" ? "anthropic" : "openai",
      defaultModel: primary === "openrouter:auto" ? "claude-sonnet-4-6" : "gpt-5.4",
      allowPluginNormalization: primary === "entry" ? false : undefined,
    }).toEqual({ provider, model });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
