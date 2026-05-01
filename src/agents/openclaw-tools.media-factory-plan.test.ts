import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { __testing } from "./openclaw-tools.js";

function createAuthStore(providers: string[] = []): AuthProfileStore {
  return {
    version: 1,
    profiles: Object.fromEntries(
      providers.map((provider) => [
        `${provider}:default`,
        {
          provider,
          type: "api_key",
          key: "test",
        },
      ]),
    ),
  };
}

function createPlugin(params: {
  id: string;
  contracts: NonNullable<PluginManifestRecord["contracts"]>;
  setupProviders?: Array<{ id: string; envVars?: string[] }>;
}): PluginManifestRecord {
  return {
    id: params.id,
    origin: "bundled",
    rootDir: `/plugins/${params.id}`,
    source: `/plugins/${params.id}/index.js`,
    manifestPath: `/plugins/${params.id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: params.contracts,
    setup: params.setupProviders ? { providers: params.setupProviders } : undefined,
  };
}

function installSnapshot(config: OpenClawConfig, plugins: PluginManifestRecord[]) {
  const snapshot = {
    policyHash: resolveInstalledPluginIndexPolicyHash(config),
    index: { plugins: [] },
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (id: string) => id,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: plugins.length,
    },
  } satisfies PluginMetadataSnapshot;
  setCurrentPluginMetadataSnapshot(snapshot, { config });
}

describe("optional media tool factory planning", () => {
  afterEach(() => {
    clearCurrentPluginMetadataSnapshot();
    vi.unstubAllEnvs();
  });

  it("skips unavailable generation and PDF factories from snapshot and run auth facts", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "video-owner",
        contracts: { videoGenerationProviders: ["video-owner"] },
        setupProviders: [{ id: "video-owner", envVars: ["VIDEO_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "music-owner",
        contracts: { musicGenerationProviders: ["music-owner"] },
        setupProviders: [{ id: "music-owner", envVars: ["MUSIC_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner", envVars: ["MEDIA_OWNER_API_KEY"] }],
      }),
    ]);

    expect(
      __testing.resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["github-copilot"]),
      }),
    ).toEqual({
      imageGenerate: false,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("keeps explicit model configs on the factory path", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          imageGenerationModel: { primary: "image-owner/model" },
          videoGenerationModel: { primary: "video-owner/model" },
          musicGenerationModel: { primary: "music-owner/model" },
          pdfModel: { primary: "media-owner/model" },
        },
      },
    };
    installSnapshot(config, []);

    expect(
      __testing.resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });

  it("skips tools that the resolved allowlist cannot expose", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["anthropic"] },
        setupProviders: [{ id: "anthropic", envVars: ["ANTHROPIC_API_KEY"] }],
      }),
    ]);

    expect(
      __testing.resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "anthropic"]),
        toolAllowlist: ["image_generate"],
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: false,
      musicGenerate: false,
      pdf: false,
    });
  });

  it("keeps auth-backed providers on the factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      createPlugin({
        id: "image-owner",
        contracts: { imageGenerationProviders: ["image-owner"] },
        setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "video-owner",
        contracts: { videoGenerationProviders: ["video-owner"] },
        setupProviders: [{ id: "video-owner", envVars: ["VIDEO_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "music-owner",
        contracts: { musicGenerationProviders: ["music-owner"] },
        setupProviders: [{ id: "music-owner", envVars: ["MUSIC_OWNER_API_KEY"] }],
      }),
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner", envVars: ["MEDIA_OWNER_API_KEY"] }],
      }),
    ]);
    vi.stubEnv("VIDEO_OWNER_API_KEY", "video-key");

    expect(
      __testing.resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner", "music-owner", "media-owner"]),
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });

  it("falls back to existing factory checks when snapshot or auth store proof is missing", () => {
    expect(__testing.resolveOptionalMediaToolFactoryPlan({ config: {} })).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });

    const config: OpenClawConfig = {};
    installSnapshot(config, []);

    expect(__testing.resolveOptionalMediaToolFactoryPlan({ config })).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });
  });
});
