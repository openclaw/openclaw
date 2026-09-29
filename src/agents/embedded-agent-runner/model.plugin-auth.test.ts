import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { getModelProviderRequestTransport } from "../provider-request-config.js";
import { resolveTieredModel } from "./model-resolution.js";
import { createEmptyPreparedModelRuntimeFixture } from "./model.fixture.test-support.js";
import { resolveModelAsync } from "./model.js";

describe("plugin-owned model authentication", () => {
  it("uses bundled catalog metadata when the shared provider has an unrelated subscription login", async () => {
    await withOpenClawTestState({ label: "plugin-static-model-auth" }, async (state) => {
      const config: OpenClawConfig = {
        models: {
          providers: {
            openai: {
              baseUrl: "https://chatgpt.com/backend-api/codex",
              api: "openai-chatgpt-responses",
              auth: "oauth",
              apiKey: { source: "env", provider: "default", id: "UNAVAILABLE_SHARED_KEY" },
              models: [],
            },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "openai",
            origin: "bundled",
            providers: ["openai"],
            providerEndpoints: [
              { endpointClass: "openai-public", hosts: ["api.openai.com"] },
              { endpointClass: "openai", hosts: ["chatgpt.com"] },
            ],
            modelCatalog: {
              providers: {
                openai: {
                  api: "openai-responses",
                  baseUrl: "https://api.openai.com/v1",
                  models: [
                    {
                      id: "gpt-plugin-test",
                      name: "Catalog model",
                      reasoning: true,
                      contextWindow: 64_000,
                      maxTokens: 4_096,
                    },
                  ],
                },
              },
              discovery: { openai: "runtime" },
            },
          },
        ],
      });
      const preparedModelRuntime = createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config,
        metadataSnapshot,
        createStores: () => {
          throw new Error("Plugin catalog metadata must not load shared auth stores");
        },
      });
      const { resolution: resolved } = await withPluginRuntimeGenerationScope(
        { metadataSnapshot },
        () =>
          resolveTieredModel({
            provider: "openai",
            modelId: "gpt-plugin-test",
            agentDir: state.agentDir(),
            config,
            harnessAuthBootstrap: "plugin",
            preparedModelRuntime,
            workspaceDir: state.workspaceDir,
            authProfileId: "openai:unavailable",
          }),
      );
      expect(resolved.model).toMatchObject({
        id: "gpt-plugin-test",
        name: "Catalog model",
        api: "openai-responses",
        reasoning: true,
        contextWindow: 64_000,
        maxTokens: 4_096,
      });
    });
  });

  it("retains configured model metadata without loading shared credentials or request secrets", async () => {
    await withOpenClawTestState({ label: "plugin-model-auth" }, async (state) => {
      const unresolvedSecret = {
        source: "env",
        provider: "default",
        id: "PROVIDER_SECRET",
      } as const;
      const config: OpenClawConfig = {
        models: {
          providers: {
            "plugin-model-provider": {
              baseUrl: "https://provider.example.test/v1",
              api: "openai-responses",
              apiKey: unresolvedSecret,
              headers: { Authorization: unresolvedSecret },
              request: { auth: { mode: "authorization-bearer", token: unresolvedSecret } },
              models: [
                {
                  id: "plugin-model",
                  name: "Configured model",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
                  contextWindow: 32_000,
                  maxTokens: 2_048,
                },
              ],
            },
          },
        },
      };
      const metadataSnapshot = createPluginMetadataSnapshotFixture();
      const preparedModelRuntime = createEmptyPreparedModelRuntimeFixture({
        agentDir: state.agentDir(),
        config,
        metadataSnapshot,
        createStores: () => {
          throw new Error("Plugin model metadata must not load shared auth stores");
        },
      });
      const resolved = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
        resolveModelAsync("plugin-model-provider", "plugin-model", state.agentDir(), config, {
          harnessAuthBootstrap: "plugin",
          preparedModelRuntime,
          workspaceDir: state.workspaceDir,
          authProfileId: "plugin-model-provider:unavailable",
        }),
      );

      expect(resolved.model).toMatchObject({
        id: "plugin-model",
        name: "Configured model",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 32_000,
        maxTokens: 2_048,
        cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
        headers: undefined,
        authHeader: undefined,
      });
      expect(getModelProviderRequestTransport(resolved.model!)).toBeUndefined();
      expect(config.models?.providers?.["plugin-model-provider"]?.apiKey).toBe(unresolvedSecret);
    });
  });
});
