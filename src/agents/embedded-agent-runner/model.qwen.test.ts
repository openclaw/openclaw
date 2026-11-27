import { fileURLToPath } from "node:url";
import { createApiRegistry, createNodeLlmRuntime } from "@openclaw/ai";
import { clampThinkingLevel } from "@openclaw/ai/internal/runtime";
import { registerBuiltInApiProviders } from "@openclaw/ai/providers";
import { expectDefined } from "@openclaw/normalization-core";
import { assert, describe, expect, it, vi } from "vitest";
import { resolveThinkingSelectionForModel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  registerProviderPlugins,
  requireRegisteredProvider,
} from "../../test-utils/plugin-registration.js";
import { resolveEnvApiKey } from "../model-auth-env.js";
import { resolveBuiltInModelSuppressionFromManifest } from "../model-suppression.js";
import type { StreamFn } from "../runtime/index.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";

const loaded = loadPluginManifest(
  fileURLToPath(new URL("../../../extensions/qwen", import.meta.url)),
);
if (!loaded.ok) {
  throw new Error(loaded.error);
}
const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [loaded.manifest] });

function configuredQwen(modelId: string, baseUrl: string): OpenClawConfig {
  const models = [
    {
      id: modelId,
      name: modelId,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262_144,
      maxTokens: 4096,
    },
  ];
  return { models: { providers: { qwen: { baseUrl, api: "openai-completions", models } } } };
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
  it.each([
    ["key only", undefined],
    ["China Coding Plan", "https://coding.dashscope.aliyuncs.com/v1"],
    ["Global Standard", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"],
    ["China Standard", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ])("sends %s requests to the selected endpoint", async (_name, baseUrl) => {
    const endpoint = baseUrl ?? "https://coding-intl.dashscope.aliyuncs.com/v1";
    const cfg = baseUrl ? configuredQwen("qwen3.5-plus", baseUrl) : {};
    const resolved = await resolveQwen("qwen3.5-plus", cfg);
    expect(resolved.error).toBeUndefined();
    if (!resolved.model) {
      throw new Error(resolved.error);
    }
    expect(resolved.model).toMatchObject({ api: "openai-completions", baseUrl: endpoint });
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
    expect([result.errorMessage, result.stopReason]).toEqual([undefined, "stop"]);
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

it.each([
  {
    contract: "no declared effort ladder",
    compat: undefined,
    levels: [
      ["minimal", "minimal", "low"],
      ["medium", "medium", "high"],
      ["xhigh", "xhigh", "xhigh"],
      ["max", "max", "xhigh"],
    ] as const,
  },
  {
    contract: "a declared low/high ladder",
    compat: { supportedReasoningEfforts: ["low", "high"] },
    levels: [
      ["low", "low", "low"],
      ["high", "high", "high"],
      ["xhigh", "high", "high"],
      ["max", "high", "high"],
    ] as const,
  },
])("resolves Qwen4-Max thinking levels with $contract", async ({ compat, levels }) => {
  const model = makeProviderModelFixture<"openai-completions">({
    provider: "qwen-token-plan",
    id: "qwen4-max",
    api: "openai-completions",
    baseUrl: "https://example.test/v1",
    reasoning: true,
    compat,
  });
  const { default: plugin } = await loadBundledPluginFacade<{
    default: Parameters<typeof registerProviderPlugins>[0];
  }>({ pluginId: "qwen", artifactBasename: "index.js" });
  const provider = requireRegisteredProvider(await registerProviderPlugins(plugin), model.provider);
  const runtimeModel =
    provider.normalizeResolvedModel?.({ provider: model.provider, modelId: model.id, model }) ??
    model;
  for (const [level, expectedLevel, effort] of levels) {
    const selected = resolveThinkingSelectionForModel({
      provider: model.provider,
      model: model.id,
      catalog: [model],
      providerPolicySource: { providers: [{ provider }] },
      level,
    });
    expect(selected.supported).toBe(true);
    assert(selected.level === level);
    const effectiveLevel = clampThinkingLevel(runtimeModel, selected.level);
    expect(effectiveLevel).toBe(expectedLevel);

    const payload = { messages: [] };
    const streamFn: StreamFn = async (requestModel, _context, options) => {
      await options?.onPayload?.(payload, requestModel);
      return createAssistantMessageEventStream();
    };
    const stream = expectDefined(
      provider.wrapStreamFn?.({
        provider: model.provider,
        modelId: model.id,
        model: runtimeModel,
        streamFn,
        thinkingLevel: selected.level,
      }),
      "Qwen Token Plan stream wrapper",
    );
    await stream(runtimeModel, { messages: [] }, { reasoning: effectiveLevel });
    expect(payload).toEqual({ messages: [], enable_thinking: true, reasoning_effort: effort });
  }
});
