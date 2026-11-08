import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { configFor } from "./model-auth.fixtures.test-support.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import * as pdfModelConfigModule from "./tools/pdf-tool.model-config.js";

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
  origin?: PluginManifestRecord["origin"];
  contracts: NonNullable<PluginManifestRecord["contracts"]>;
  imageGenerationProviderMetadata?: PluginManifestRecord["imageGenerationProviderMetadata"];
  videoGenerationProviderMetadata?: PluginManifestRecord["videoGenerationProviderMetadata"];
  musicGenerationProviderMetadata?: PluginManifestRecord["musicGenerationProviderMetadata"];
  setupProviders?: Array<{ id: string; envVars?: string[] }>;
}): PluginManifestRecord {
  return {
    id: params.id,
    origin: params.origin ?? "bundled",
    rootDir: `/plugins/${params.id}`,
    source: `/plugins/${params.id}/index.js`,
    manifestPath: `/plugins/${params.id}/openclaw.plugin.json`,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    contracts: params.contracts,
    imageGenerationProviderMetadata: params.imageGenerationProviderMetadata,
    videoGenerationProviderMetadata: params.videoGenerationProviderMetadata,
    musicGenerationProviderMetadata: params.musicGenerationProviderMetadata,
    setup: params.setupProviders ? { providers: params.setupProviders } : undefined,
  };
}

function createExplicitMediaModelConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        mediaModels: {
          image: { primary: "image-owner/model" },
          video: { primary: "video-owner/model" },
          music: { primary: "music-owner/model" },
        },
        pdfModel: { primary: "media-owner/model" },
      },
    },
  };
}

function createStandardMediaPlugins(mediaProvider = "media-owner"): PluginManifestRecord[] {
  const mediaEnvVar = mediaProvider === "anthropic" ? "ANTHROPIC_API_KEY" : "MEDIA_OWNER_API_KEY";
  return [
    ...(["image", "video", "music"] as const).map((kind) =>
      createPlugin({
        id: `${kind}-owner`,
        contracts: { [`${kind}GenerationProviders`]: [`${kind}-owner`] },
        setupProviders: [{ id: `${kind}-owner`, envVars: [`${kind.toUpperCase()}_OWNER_API_KEY`] }],
      }),
    ),
    createPlugin({
      id: "media-owner",
      contracts: { mediaUnderstandingProviders: [mediaProvider] },
      setupProviders: [{ id: mediaProvider, envVars: [mediaEnvVar] }],
    }),
  ];
}

function installSnapshot(
  config: OpenClawConfig,
  plugins: PluginManifestRecord[],
  workspaceDir?: string,
) {
  const prepared = createPluginMetadataSnapshotFixture({ plugins });
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const index = { ...prepared.index, policyHash };
  const snapshot = finalizePluginMetadataSnapshot({
    ...prepared,
    policyHash,
    ...(workspaceDir ? { workspaceDir } : {}),
    index,
    registryIndex: index,
  });
  setCurrentPluginMetadataSnapshot(snapshot, { config });
  return snapshot;
}

describe("optional media tool factory planning", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    clearSecretsRuntimeSnapshot();
  });

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    clearSecretsRuntimeSnapshot();
    vi.unstubAllEnvs();
  });

  it.each([
    { providers: [], auth: ["media-owner"], expected: false },
    {
      providers: [{ id: "media-owner", capabilities: ["image"] }],
      auth: ["media-owner"],
      expected: true,
    },
    {
      providers: [
        { id: "audio-auth", capabilities: ["audio"] },
        { id: "image-no-auth", capabilities: ["image"] },
      ],
      auth: ["audio-auth"],
      expected: false,
    },
  ])(
    "requires image capability and auth on the same prepared provider: $expected",
    ({ providers, auth, expected }) => {
      const config: OpenClawConfig = {};
      const snapshot = installSnapshot(config, [
        createPlugin({
          id: "media-owner",
          contracts: {
            mediaUnderstandingProviders: ["media-owner", "audio-auth", "image-no-auth"],
          },
        }),
      ]);
      expect(
        resolveImageToolFactoryAvailable({
          config,
          agentDir: "/agent",
          authStore: createAuthStore(auth),
          preparedModelRuntime: {
            metadataSnapshot: snapshot,
            mediaCapabilityProviders: { mediaUnderstandingProviders: providers },
          } as never,
        }),
      ).toBe(expected);
    },
  );

  it("keeps config vision routes while gating OpenAI subscription auth on prepared Codex", () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const config = {
      models: {
        providers: {
          custom: {
            baseUrl: "https://vision.example/v1",
            models: [{ id: "vision", input: ["text", "image"] }],
          },
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-image", input: ["text", "image"] }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const snapshot = installSnapshot(config, []);
    const preparedModelRuntime = {
      metadataSnapshot: snapshot,
      mediaCapabilityProviders: { mediaUnderstandingProviders: [] },
    } as never;
    const oauthStore = createAuthStore();
    oauthStore.profiles["openai:default"] = {
      provider: "openai",
      type: "oauth",
      access: "test",
      refresh: "test",
      expires: Date.now() + 60_000,
    };

    const available = (authStore: AuthProfileStore, prepared: unknown = preparedModelRuntime) =>
      resolveImageToolFactoryAvailable({
        config,
        agentDir: "/agent",
        authStore,
        preparedModelRuntime: prepared as never,
      });

    expect(available(createAuthStore(["custom"]))).toBe(true);
    expect(available(oauthStore)).toBe(false);
    for (const [capabilities, expected] of [
      [["audio"], false],
      [["image"], true],
    ] as const) {
      const mediaUnderstandingProviders = [{ id: "codex", capabilities }];
      expect(
        available(oauthStore, {
          metadataSnapshot: snapshot,
          mediaCapabilityProviders: { mediaUnderstandingProviders },
        }),
      ).toBe(expected);
    }
    // A key on the provider entry is usable auth; a marker counts only on a local route.
    const custom = config.models?.providers?.custom ?? {};
    Object.assign(custom, { apiKey: "ollama-local" });
    expect(available(createAuthStore())).toBe(false);
    Object.assign(custom, { api: "ollama", baseUrl: "http://localhost:11434" });
    expect(available(createAuthStore())).toBe(true);
    Object.assign(custom, { api: undefined, baseUrl: "https://vision.example/v1", apiKey: "k" });
    expect(available(createAuthStore())).toBe(true);
  });

  it("does not plan media factories from workspace-scoped metadata without workspace context", () => {
    // Workspace snapshots are process-local facts and must not leak to unrelated runs.
    const config: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    installSnapshot(
      config,
      [
        createPlugin({
          id: "image-owner",
          contracts: { imageGenerationProviders: ["image-owner"] },
          setupProviders: [{ id: "image-owner", envVars: ["IMAGE_OWNER_API_KEY"] }],
        }),
      ],
      "/workspace/a",
    );
    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(["image-owner"]),
      }).imageGenerate,
    ).toBe(false);
    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        workspaceDir: "/workspace/a",
        authStore: createAuthStore(["image-owner"]),
      }).imageGenerate,
    ).toBe(true);
  });

  it("preserves implicit allow-all from alsoAllow-only policies for built-in media factories", () => {
    const config = createExplicitMediaModelConfig();
    const allowlistFromAlsoAllowOnlyPolicy = ["group:memory", DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY];
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
        toolAllowlist: allowlistFromAlsoAllowOnlyPolicy,
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: true,
      musicGenerate: true,
      pdf: true,
    });

    const toolNames = createOpenClawTools({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      authProfileStore: createAuthStore(),
      pluginToolAllowlist: allowlistFromAlsoAllowOnlyPolicy,
    }).map((tool) => tool.name);
    expect(toolNames).toContain("image_generate");
    expect(toolNames).toContain("video_generate");
    expect(toolNames).toContain("music_generate");
    expect(toolNames).toContain("pdf");
  });

  it("keeps denylists authoritative when alsoAllow-only policies preserve factory construction", () => {
    const config = createExplicitMediaModelConfig();
    installSnapshot(config, []);

    expect(
      resolveOptionalMediaToolFactoryPlan({
        config,
        authStore: createAuthStore(),
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY],
        toolDenylist: ["video_generate", "pdf"],
      }),
    ).toEqual({
      imageGenerate: true,
      videoGenerate: false,
      musicGenerate: true,
      pdf: false,
    });
  });

  it("keeps auth-backed providers on the factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, createStandardMediaPlugins());
    vi.stubEnv("VIDEO_OWNER_API_KEY", "video-key");

    expect(
      resolveOptionalMediaToolFactoryPlan({
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

  it("plans media tools for inline and env-backed keys unless the inline key is cooling down", () => {
    vi.stubEnv("MEDIA_INLINE_TEST_KEY", "synthetic-inline-key");
    const owners = ["image-owner", "video-owner", "music-owner", "media-owner"];
    const providers: Record<string, ModelProviderConfig> = Object.fromEntries(
      owners.map((id) => [id, { baseUrl: "https://media.example/v1", models: [] }]),
    );
    const config: OpenClawConfig = { models: { providers } };
    installSnapshot(config, createStandardMediaPlugins());
    const plan = (authStore = createAuthStore()) =>
      resolveOptionalMediaToolFactoryPlan({ config, authStore });
    const expected = (available: boolean) => ({
      imageGenerate: available,
      videoGenerate: available,
      musicGenerate: available,
      pdf: available,
    });
    const cooling: AuthProfileStore = {
      ...createAuthStore(),
      usageStats: Object.fromEntries(
        owners.map((id) => [`inline-api-key:${id}`, { cooldownUntil: Date.now() + 60_000 }]),
      ),
    };
    for (const apiKey of [
      undefined,
      "synthetic-key",
      { source: "env", provider: "default", id: "MEDIA_INLINE_TEST_KEY" },
    ] as const) {
      for (const provider of Object.values(providers)) {
        provider.apiKey = apiKey;
      }
      expect(plan()).toEqual(expected(apiKey !== undefined));
      expect(plan(cooling)).toEqual(expected(false));
    }
    vi.stubEnv("MEDIA_INLINE_TEST_KEY", "");
    expect(plan()).toEqual(expected(false));
  });

  it("defers PDF resolution and passes the active model at execution", async () => {
    const config: OpenClawConfig = {};
    const workspaceDir = process.cwd();
    vi.stubEnv("ANTHROPIC_API_KEY", "unrelated-fixture-key");
    // No automatic PDF model exists in this workspace; only the active model can qualify.
    installSnapshot(config, createStandardMediaPlugins("openrouter"), workspaceDir);
    const resolveSpy = vi.spyOn(pdfModelConfigModule, "resolvePdfModelConfigForTool");

    for (const modelHasVision of [true, false]) {
      const callCountBeforePrep = resolveSpy.mock.calls.length;
      const tools = createOpenClawTools({
        config,
        agentDir: "/tmp/openclaw-agent-main",
        workspaceDir,
        authProfileStore: createAuthStore(["openrouter"]),
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4.1-flash",
        modelHasVision,
      });

      const pdfTool = tools.find((tool) => tool.name === "pdf");
      expect(pdfTool).toBeDefined();
      expect(resolveSpy).toHaveBeenCalledTimes(callCountBeforePrep);

      const execution = pdfTool?.execute("pdf-active-model-handoff", {
        pdf: "ftp://example.com/active-model-handoff.pdf",
      });
      if (modelHasVision) {
        await expect(execution).resolves.toMatchObject({
          details: { error: "unsupported_pdf_reference" },
        });
      } else {
        await expect(execution).rejects.toThrow("No PDF model configured.");
      }
    }
  });

  it("rechecks workspace capability activation after the selected slot changes", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, [
      {
        ...createPlugin({
          id: "workspace-image",
          origin: "workspace",
          contracts: { imageGenerationProviders: ["workspace-image"] },
        }),
        kind: "context-engine",
      },
    ]);
    const authStore = createAuthStore(["workspace-image"]);
    const available = () =>
      resolveOptionalMediaToolFactoryPlan({ config, authStore }).imageGenerate;

    expect(available()).toBe(false);
    config.plugins = { slots: { contextEngine: "workspace-image" } };
    expect(available()).toBe(true);
    config.plugins = {};
    expect(available()).toBe(false);
  });

  it("honors manifest-declared image provider auth alias base-url guards", () => {
    const config: OpenClawConfig = configFor("openai", "http://localhost:11434/v1");
    installSnapshot(config, [
      createPlugin({
        id: "openai",
        contracts: { imageGenerationProviders: ["openai"] },
        imageGenerationProviderMetadata: {
          openai: {
            aliases: ["openai"],
            authSignals: [
              {
                provider: "openai",
                providerBaseUrl: {
                  provider: "openai",
                  defaultBaseUrl: "https://api.openai.com/v1",
                  allowedBaseUrls: ["https://api.openai.com/v1"],
                },
              },
            ],
          },
        },
      }),
    ]);

    const plan = resolveOptionalMediaToolFactoryPlan({
      config,
      authStore: createAuthStore(["openai"]),
    });
    expect(plan.imageGenerate).toBe(false);
  });
});
