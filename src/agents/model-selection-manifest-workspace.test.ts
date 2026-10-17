// Verifies configured model selection uses manifest policy only in scoped contexts.
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const defaultNormalizationSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "default-normalizer",
      modelIdNormalization: {
        providers: { openai: { aliases: { entry: "middle", middle: "final" } } },
      },
    },
  ],
});

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

describe("configured model manifest workspace scope", () => {
  beforeEach(() => {
    loadManifestMetadataSnapshotMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReset();
    getActivePluginRegistryWorkspaceDirFromStateMock.mockReset();
    normalizeProviderModelIdWithRuntimeMock.mockReset();
    getCurrentPluginMetadataSnapshotMock.mockReturnValue(undefined);
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({
        custom: {
          prefixWhenBare: "workspace-custom",
        },
      }),
    );
  });

  it("does not reuse workspace manifest policies without a workspace context", () => {
    // Workspace plugin normalization must not leak into unscoped callers; they
    // can only use the current global metadata snapshot.
    const cfg = createCatalogConfig();

    expect(buildConfiguredModelCatalog({ cfg })).toMatchObject([
      {
        provider: "custom",
        id: "fast-model",
      },
    ]);
    expect(getCurrentPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: cfg,
      env: process.env,
    });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
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
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
  });

  it("does not load manifest metadata for wildcard-only configured model aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/*": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const aliases = buildModelAliasIndex({ cfg, defaultProvider: "anthropic" });

    expect(aliases.byAlias.size).toBe(0);
    expect(aliases.byKey.size).toBe(0);
    expect(getCurrentPluginMetadataSnapshotMock.mock.calls.length).toBe(0);
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
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

    expect(
      resolveConfiguredModelRef({
        cfg,
        agentId: "ops",
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-sol",
      }),
    ).toEqual({ provider: "openai", model: "ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    expect(normalizeProviderModelIdWithRuntimeMock.mock.calls.length).toBe(0);
  });

  it("preserves workspace manifest policy for default-provider aliases", () => {
    getActivePluginRegistryWorkspaceDirFromStateMock.mockReturnValue("/workspace/a");
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({ openai: { aliases: { ops: "workspace-ops" } } }),
    );
    const cfg = {
      agents: { defaults: { models: { "openai/ops": { alias: "Operations" } } } },
    } as unknown as OpenClawConfig;

    expect(
      buildModelAliasIndex({ cfg, defaultProvider: "openai" }).byAlias.get("operations")?.ref,
    ).toEqual({ provider: "openai", model: "workspace-ops" });
    expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(1);
    expect(loadManifestMetadataSnapshotMock.mock.calls[0]?.[0]?.workspaceDir).toBe("/workspace/a");
  });

  it.each([{ name: "explicit", primary: "openai/entry", models: undefined }])(
    "does not renormalize the $name selection",
    ({ primary, models }) => {
      const manifestPlugins = defaultNormalizationSnapshot;
      expect(
        resolveConfiguredModelRef({
          cfg: { agents: { defaults: { model: { primary }, models } } },
          defaultProvider: "openai",
          defaultModel: "unused",
          manifestPlugins,
          allowPluginNormalization: false,
        }),
      ).toEqual({ provider: "openai", model: "middle" });
    },
  );

  it.each([{ manifest: false, runtime: true, expected: "runtime-entry" }])(
    "honors captured normalization flags (manifest=$manifest, runtime=$runtime)",
    ({ manifest, runtime, expected }) => {
      normalizeProviderModelIdWithRuntimeMock.mockImplementation(
        ({ context }: { context: { modelId: string } }) => `runtime-${context.modelId}`,
      );
      expect(
        resolveConfiguredModelRef({
          cfg: { agents: { defaults: { model: "entry" } } },
          defaultProvider: "openai",
          defaultModel: "unused",
          manifestPlugins: defaultNormalizationSnapshot,
          allowManifestNormalization: manifest,
          allowPluginNormalization: runtime,
        }),
      ).toEqual({ provider: "openai", model: expected });
      expect(normalizeProviderModelIdWithRuntimeMock).toHaveBeenCalledTimes(runtime ? 1 : 0);
      expect(getCurrentPluginMetadataSnapshotMock.mock.calls.length).toBe(0);
      expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    },
  );

  it("reuses metadata captured during unsuccessful provider inference", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(defaultNormalizationSnapshot);
    expect(
      resolveConfiguredModelRef({
        cfg: { agents: { defaults: { model: "entry", models: { "custom/unrelated": {} } } } },
        defaultProvider: "openai",
        defaultModel: "unused",
        allowPluginNormalization: false,
      }),
    ).toEqual({ provider: "openai", model: "middle" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("preserves the configured native API owner for a captured bare default", () => {
    normalizeProviderModelIdWithRuntimeMock.mockReturnValue("wrong-runtime-model");
    expect(
      resolveConfiguredModelRef({
        cfg: {
          agents: { defaults: { model: "entry@work" } },
          models: {
            providers: {
              openai: { api: "ollama", baseUrl: "https://fixture.invalid", models: [] },
            },
          },
        },
        defaultProvider: "openai",
        defaultModel: "unused",
        manifestPlugins: defaultNormalizationSnapshot,
      }),
    ).toEqual({ provider: "openai", model: "middle" });
    expect(normalizeProviderModelIdWithRuntimeMock).not.toHaveBeenCalled();
  });

  it.each([
    { primary: "entry@", expected: "entry@" },
    { primary: "/", expected: "unused" },
  ])(
    "keeps existing parser behavior for captured malformed input '$primary'",
    ({ primary, expected }) => {
      expect(
        resolveConfiguredModelRef({
          cfg: { agents: { defaults: { model: { primary } } } },
          defaultProvider: "openai",
          defaultModel: "unused",
          manifestPlugins: [],
          allowPluginNormalization: false,
        }),
      ).toEqual({ provider: "openai", model: expected });
      expect(getCurrentPluginMetadataSnapshotMock.mock.calls.length).toBe(0);
      expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    },
  );

  it("does not load manifest metadata for statically resolved primary models", () => {
    const cases: Array<{ cfg: OpenClawConfig; expected: { provider: string; model: string } }> = [
      {
        cfg: {
          agents: { defaults: { model: { primary: "sonnet-4.6" } } },
        } as unknown as OpenClawConfig,
        expected: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      {
        cfg: {
          agents: { defaults: { model: { primary: "gpt-5.5" } } },
          models: { providers: { openai: { models: [{ id: "gpt-5.5" }] } } },
        } as unknown as OpenClawConfig,
        expected: { provider: "openai", model: "gpt-5.5" },
      },
    ];

    for (const { cfg, expected } of cases) {
      getCurrentPluginMetadataSnapshotMock.mockClear();
      loadManifestMetadataSnapshotMock.mockClear();
      expect(
        resolveConfiguredModelRef({
          cfg,
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4-6",
        }),
      ).toEqual(expected);
      expect(getCurrentPluginMetadataSnapshotMock.mock.calls.length).toBe(0);
      expect(loadManifestMetadataSnapshotMock.mock.calls.length).toBe(0);
    }
  });

  it("uses manifest-normalized configured refs to infer providers for bare defaults", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({
        anthropic: {
          aliases: {
            "sonnet-4.6": "claude-sonnet-4-6",
          },
        },
      }),
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "claude-sonnet-4-6" },
          models: {
            "anthropic/sonnet-4.6": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("reuses resolved manifest plugins while resolving direct primary models", () => {
    loadManifestMetadataSnapshotMock.mockReturnValue(
      normalizationSnapshot({
        anthropic: {
          aliases: {
            "sonnet-4.6": "claude-sonnet-4-6",
          },
        },
        openrouter: {
          prefixWhenBare: "openrouter",
        },
      }),
    );
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openrouter:auto" },
          models: {
            "anthropic/sonnet-4.6": { alias: "sonnet" },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveConfiguredModelRef({
        cfg,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
      }),
    ).toEqual({ provider: "openrouter", model: "openrouter/auto" });
    expect(loadManifestMetadataSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
