import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { finalizePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createPluginManifestRecordFixture,
  createPluginMetadataSnapshotFixture,
} from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import {
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY } from "./tool-policy.js";
import { loadCapabilityMetadataSnapshot } from "./tools/manifest-capability-availability.js";
import * as pdfModelConfigModule from "./tools/pdf-tool.model-config.js";

const createAuthStore = (providers: string[] = []): AuthProfileStore => ({
  version: 1,
  profiles: Object.fromEntries(
    providers.map((provider) => [
      `${provider}:default`,
      { provider, type: "api_key", key: "test" },
    ]),
  ),
});

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

function generationPlugin(kind: "image" | "video" | "music") {
  const id = `${kind}-owner`;
  return createPluginManifestRecordFixture({
    id,
    rootDir: `/plugins/${id}`,
    contracts: { [`${kind}GenerationProviders`]: [id] },
    setup: { providers: [{ id, envVars: [`${kind.toUpperCase()}_OWNER_API_KEY`] }] },
  });
}

function createStandardMediaPlugins(mediaProvider = "media-owner"): PluginManifestRecord[] {
  return [
    ...(["image", "video", "music"] as const).map(generationPlugin),
    createPluginManifestRecordFixture({
      id: "media-owner",
      rootDir: "/plugins/media-owner",
      contracts: { mediaUnderstandingProviders: [mediaProvider] },
      setup: { providers: [{ id: mediaProvider, envVars: ["MEDIA_OWNER_API_KEY"] }] },
    }),
  ];
}

const allMedia = { imageGenerate: true, videoGenerate: true, musicGenerate: true, pdf: true };
type PlanOptions = Parameters<typeof resolveOptionalMediaToolFactoryPlan>[0];
function plan(
  config: OpenClawConfig,
  providers: string[] = [],
  options: Omit<PlanOptions, "config" | "authStore"> = {},
) {
  return resolveOptionalMediaToolFactoryPlan({
    config,
    authStore: createAuthStore(providers),
    ...options,
  });
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

  it("uses the prepared media family for image-tool availability", () => {
    const config: OpenClawConfig = {};
    const snapshot = installSnapshot(config, [
      createPlugin({
        id: "media-owner",
        contracts: { mediaUnderstandingProviders: ["media-owner"] },
        setupProviders: [{ id: "media-owner" }],
      }),
    ]);
    const base = {
      config,
      agentDir: "/agent",
      authStore: createAuthStore(["media-owner"]),
    };

    expect(
      resolveImageToolFactoryAvailable({
        ...base,
        preparedModelRuntime: {
          metadataSnapshot: snapshot,
          mediaCapabilityProviders: { mediaUnderstandingProviders: [] },
        } as never,
      }),
    ).toBe(false);
    expect(
      resolveImageToolFactoryAvailable({
        ...base,
        preparedModelRuntime: {
          metadataSnapshot: snapshot,
          mediaCapabilityProviders: {
            mediaUnderstandingProviders: [{ id: "media-owner", capabilities: ["image"] }],
          },
        } as never,
      }),
    ).toBe(true);
  });

  it("requires image capability and auth on the same prepared provider", () => {
    const config: OpenClawConfig = {};
    const snapshot = installSnapshot(config, [
      createPlugin({
        id: "media-owner",
        contracts: {
          mediaUnderstandingProviders: ["audio-auth", "image-no-auth"],
        },
        setupProviders: [{ id: "audio-auth" }, { id: "image-no-auth" }],
      }),
    ]);

    expect(
      resolveImageToolFactoryAvailable({
        config,
        agentDir: "/agent",
        authStore: createAuthStore(["audio-auth"]),
        preparedModelRuntime: {
          metadataSnapshot: snapshot,
          mediaCapabilityProviders: {
            mediaUnderstandingProviders: [
              { id: "audio-auth", capabilities: ["audio"] },
              { id: "image-no-auth", capabilities: ["image"] },
            ],
          },
        } as never,
      }),
    ).toBe(false);
  });

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

    const available = (authStore: AuthProfileStore, runtime = preparedModelRuntime) =>
      resolveImageToolFactoryAvailable({
        config,
        agentDir: "/agent",
        authStore,
        preparedModelRuntime: runtime,
      });
    expect(available(createAuthStore(["custom"]))).toBe(true);
    expect(available(oauthStore)).toBe(false);
    for (const [capabilities, expected] of [
      [["audio"], false],
      [["image"], true],
    ] as const) {
      expect(
        available(oauthStore, {
          metadataSnapshot: snapshot,
          mediaCapabilityProviders: {
            mediaUnderstandingProviders: [{ id: "codex", capabilities }],
          },
        } as never),
      ).toBe(expected);
    }
  });

  it("does not plan media factories from workspace-scoped metadata without workspace context", () => {
    const config: OpenClawConfig = {};
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    installSnapshot(config, [generationPlugin("image")], "/workspace/a");
    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/a" }),
    ).toBeDefined();
    expect(
      loadCapabilityMetadataSnapshot({ config }).plugins.map((plugin) => plugin.id),
    ).not.toContain("image-owner");

    expect(plan(config, ["image-owner"]).imageGenerate).toBe(false);
    expect(plan(config, ["image-owner"], { workspaceDir: "/workspace/a" }).imageGenerate).toBe(
      true,
    );
  });

  it("preserves implicit allow-all from alsoAllow-only policies for built-in media factories", () => {
    const config = createExplicitMediaModelConfig();
    const allowlistFromAlsoAllowOnlyPolicy = ["group:memory", DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY];
    installSnapshot(config, []);

    expect(plan(config, [], { toolAllowlist: allowlistFromAlsoAllowOnlyPolicy })).toEqual(allMedia);

    const toolNames = createOpenClawTools({
      config,
      agentDir: "/tmp/openclaw-agent-main",
      authProfileStore: createAuthStore(),
      pluginToolAllowlist: allowlistFromAlsoAllowOnlyPolicy,
    }).map((tool) => tool.name);
    expect(toolNames).toEqual(
      expect.arrayContaining(["image_generate", "video_generate", "music_generate", "pdf"]),
    );
  });

  it("keeps denylists authoritative when alsoAllow-only policies preserve factory construction", () => {
    const config = createExplicitMediaModelConfig();
    installSnapshot(config, []);

    expect(
      plan(config, [], {
        toolAllowlist: [DEFAULT_PLUGIN_TOOLS_ALLOWLIST_ENTRY],
        toolDenylist: ["video_generate", "pdf"],
      }),
    ).toEqual({ ...allMedia, videoGenerate: false, pdf: false });
  });

  it("keeps auth-backed providers on the factory path", () => {
    const config: OpenClawConfig = {};
    installSnapshot(config, createStandardMediaPlugins());
    vi.stubEnv("VIDEO_OWNER_API_KEY", "video-key");

    expect(plan(config, ["image-owner", "music-owner", "media-owner"])).toEqual(allMedia);
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
      createPluginManifestRecordFixture({
        id: "workspace-image",
        rootDir: "/plugins/workspace-image",
        origin: "workspace",
        contracts: { imageGenerationProviders: ["workspace-image"] },
        kind: "context-engine",
      }),
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
    const config: OpenClawConfig = {
      models: { providers: { openai: { baseUrl: "http://localhost:11434/v1", models: [] } } },
    };
    const providerBaseUrl = {
      provider: "openai",
      defaultBaseUrl: "https://api.openai.com/v1",
      allowedBaseUrls: ["https://api.openai.com/v1"],
    };
    const authSignals = [{ provider: "openai", providerBaseUrl }];
    installSnapshot(config, [
      createPluginManifestRecordFixture({
        id: "openai",
        rootDir: "/plugins/openai",
        contracts: { imageGenerationProviders: ["openai"] },
        imageGenerationProviderMetadata: { openai: { aliases: ["openai"], authSignals } },
      }),
    ]);

    expect(plan(config, ["openai"]).imageGenerate).toBe(false);
  });
});
