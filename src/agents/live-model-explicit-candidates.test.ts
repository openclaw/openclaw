import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExplicitLiveModelCandidates } from "../gateway/gateway-models.profiles.live.test-helpers.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as authProfileStore from "./auth-profiles/store-runtime.js";
import { createEmptyAgentDiscoveryStores } from "./embedded-agent-runner/model.js";
import { appendLiveModelCandidates } from "./test-helpers/live-model-dynamic-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: ["deepseek", "xai"].map((id) => {
    const rootDir = fileURLToPath(new URL(`../../extensions/${id}`, import.meta.url));
    const loaded = loadPluginManifest(rootDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return Object.assign(loaded.manifest, { rootDir, source: path.join(rootDir, "index.ts") });
  }),
});
const config: OpenClawConfig = {
  plugins: {
    enabled: true,
    allow: ["deepseek", "xai"],
    entries: { deepseek: { enabled: true }, xai: { enabled: true } },
  },
};
const agentDir = "/fixture/live-explicit-models/agent";
const fetchMock = vi.fn(() => {
  throw new Error("Model selection must not make network requests");
});

beforeEach(() => {
  // Model selection uses empty auth data; credential storage is outside this contract.
  vi.spyOn(authProfileStore, "loadAuthProfileStoreForRuntimeAsync").mockResolvedValue({
    version: 1,
    profiles: {},
  });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("explicit live model candidates", () => {
  it("recovers accepted DeepSeek selections omitted from discovery using one captured store", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const stores = createEmptyAgentDiscoveryStores();
      const getDiscoveryStores = vi.fn(async () => stores);
      const result = await appendLiveModelCandidates({
        models: [],
        config,
        agentDir,
        modelRegistry: stores.modelRegistry,
        resolution: { kind: "explicit", getDiscoveryStores },
        refs: [
          { provider: "deepseek", id: "deepseek-v4-flash" },
          { provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
        ],
      });

      expect(result.models).toMatchObject([
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          api: "openai-completions",
          baseUrl: "https://api.deepseek.com",
          input: ["text"],
        },
        {
          provider: "deepseek",
          id: "deepseek-v4-flash-vision-exp",
          api: "openai-completions",
          baseUrl: "https://api.deepseek.com",
          input: ["text", "image"],
        },
      ]);
      expect(result.added).toHaveLength(2);
      expect(getDiscoveryStores).toHaveBeenCalledOnce();
    });
  });

  it("keeps configured transport and model limits when recovering a bundled selection", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const stores = createEmptyAgentDiscoveryStores();
      const result = await appendLiveModelCandidates({
        models: [],
        config: {
          ...config,
          models: {
            providers: {
              deepseek: {
                api: "openai-completions",
                baseUrl: "https://deepseek-proxy.example.invalid/v1",
                headers: { "X-Tenant": "fixture" },
                models: [
                  {
                    id: "deepseek-v4-flash",
                    name: "Configured Flash",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 64_000,
                    maxTokens: 8_000,
                  },
                ],
              },
            },
          },
        },
        agentDir,
        modelRegistry: stores.modelRegistry,
        resolution: { kind: "explicit", getDiscoveryStores: async () => stores },
        refs: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
      });

      expect(result.models).toMatchObject([
        {
          provider: "deepseek",
          id: "deepseek-v4-flash",
          name: "Configured Flash",
          api: "openai-completions",
          baseUrl: "https://deepseek-proxy.example.invalid/v1",
          headers: { "X-Tenant": "fixture" },
          contextWindow: 64_000,
          maxTokens: 8_000,
        },
      ]);
    });
  });

  it("does not acquire discovery stores when every explicit selection is already present", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const stores = createEmptyAgentDiscoveryStores();
      const model = makeProviderModelFixture({
        provider: "deepseek",
        id: "deepseek-v4-flash",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com",
      });
      const getDiscoveryStores = vi.fn(async () => stores);
      const result = await appendLiveModelCandidates({
        models: [model],
        config,
        agentDir,
        modelRegistry: stores.modelRegistry,
        resolution: { kind: "explicit", getDiscoveryStores },
        refs: [{ provider: "deepseek", id: "deepseek-v4-flash" }],
      });

      expect(result.models).toEqual([model]);
      expect(result.added).toEqual([]);
      expect(getDiscoveryStores).not.toHaveBeenCalled();
    });
  });

  it("does not manufacture an unknown explicit selection", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const stores = createEmptyAgentDiscoveryStores();
      const result = await appendLiveModelCandidates({
        models: [],
        config,
        agentDir,
        modelRegistry: stores.modelRegistry,
        resolution: { kind: "explicit", getDiscoveryStores: async () => stores },
        refs: [{ provider: "deepseek", id: "not-a-deepseek-model" }],
      });

      expect(result).toEqual({ models: [], added: [] });
    });
  });

  it("does not revive a suppressed model present in the captured registry", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const stores = createEmptyAgentDiscoveryStores();
      stores.modelRegistry.registerProvider("xai", {
        api: "openai-completions",
        baseUrl: "https://api.x.ai/v1",
        models: [
          {
            id: "grok-4.20-multi-agent-0309",
            name: "Suppressed model",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 4_096,
          },
        ],
      });
      const result = await appendLiveModelCandidates({
        models: [],
        config,
        agentDir,
        modelRegistry: stores.modelRegistry,
        resolution: { kind: "explicit", getDiscoveryStores: async () => stores },
        refs: [{ provider: "xai", id: "grok-4.20-multi-agent-0309" }],
      });

      expect(result).toEqual({ models: [], added: [] });
      const registered = stores.modelRegistry.getAll();
      expect(registered).toHaveLength(1);
      expect(() =>
        resolveExplicitLiveModelCandidates({
          modelRegistry: stores.modelRegistry,
          models: registered,
          modelFilter: new Set(["xai/grok-4.20-multi-agent-0309"]),
          providerFilter: new Set(["xai"]),
          config,
          env: {},
        }),
      ).toThrow(/xai\/grok-4.20-multi-agent-0309/);
    });
  });
});
