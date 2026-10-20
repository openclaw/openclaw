import { fileURLToPath } from "node:url";
import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveEnvApiKey } from "../model-auth-env.js";
import { resolveBuiltInModelSuppressionFromManifest } from "../model-suppression.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";
import { createBundledStaticCatalogModelResolver } from "./model.static-catalog.js";

const loaded = loadPluginManifest(
  fileURLToPath(new URL("../../../extensions/qwen", import.meta.url)),
);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [loaded.manifest] });

function configuredQwen(modelId: string, baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        qwen: {
          baseUrl,
          api: "openai-completions",
          models: [
            {
              id: modelId,
              name: modelId,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 262_144,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
  };
}

function resolveQwen(modelId: string, cfg: OpenClawConfig = {}) {
  return withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
    resolveModelAsync("qwen", modelId, "/unused-qwen-agent", cfg, {
      ...createEmptyAgentDiscoveryStores(),
      skipAgentDiscovery: true,
      skipProviderRuntimeHooks: true,
      authProfileMode: "api_key",
      allowBundledStaticCatalogFallback: true,
    }),
  );
}

describe("Qwen static fallback routing", () => {
  it("inherits the provider endpoint when the model row has none", () => {
    const resolve = createBundledStaticCatalogModelResolver({
      metadataSnapshot,
      cfg: {},
      includeRuntimeDiscovery: true,
    });
    expect(resolve({ provider: "qwen", modelId: "qwen3.5-plus" })).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
    });
  });

  it.each([
    {
      name: "key only",
      baseUrl: undefined,
      endpoint: "https://coding-intl.dashscope.aliyuncs.com/v1",
    },
    {
      name: "China Coding Plan",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      endpoint: "https://coding.dashscope.aliyuncs.com/v1",
    },
    {
      name: "Global Standard",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    {
      name: "China Standard",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    },
  ])("sends $name requests to the selected endpoint", async ({ baseUrl, endpoint }) => {
    const cfg = baseUrl ? configuredQwen("qwen3.5-plus", baseUrl) : {};
    const resolved = await resolveQwen("qwen3.5-plus", cfg);
    expect(resolved.error).toBeUndefined();
    if (!resolved.model) {
      throw new Error(resolved.error);
    }
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(
        'data: {"id":"fixture","object":"chat.completion.chunk","created":0,"model":"qwen3.5-plus","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const registry = createApiRegistry();
    registerBuiltInApiProviders(registry);
    const runtime = createNodeLlmRuntime(registry, { buildModelFetch: () => fetch });
    const auth = withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      resolveEnvApiKey("qwen", { MODELSTUDIO_API_KEY: "synthetic-qwen-key" }),
    );
    expect(auth?.source).toBe("env: MODELSTUDIO_API_KEY");
    const result = await runtime
      .stream(
        resolved.model,
        { messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: 1 }] },
        { apiKey: auth?.apiKey },
      )
      .result();
    expect(result.errorMessage).toBeUndefined();
    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${endpoint}/chat/completions`);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer synthetic-qwen-key");
    expect(await requests[0]?.json()).toMatchObject({ model: "qwen3.5-plus" });
  });

  it.each([
    { baseUrl: undefined, supported: false },
    { baseUrl: "https://coding.dashscope.aliyuncs.com/v1", supported: false },
    { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", supported: true },
    { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", supported: true },
  ])("checks qwen3.8-max support against $baseUrl", async ({ baseUrl, supported }) => {
    const suppression = resolveBuiltInModelSuppressionFromManifest({
      provider: "qwen",
      id: "qwen3.8-max",
      baseUrl,
      metadataSnapshot,
    });
    expect(suppression?.suppress ?? false).toBe(!supported);
    if (!baseUrl) {
      const resolved = await resolveQwen("qwen3.8-max");
      expect(resolved.error).toContain("not supported on the Qwen Coding Plan endpoint");
    }
  });
});
