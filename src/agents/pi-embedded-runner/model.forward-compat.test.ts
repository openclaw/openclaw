import { describe, it } from "vitest";
import {
  buildForwardCompatTemplate,
  expectResolvedForwardCompatFallbackWithRegistryResult,
} from "./model.forward-compat.test-support.js";
import { resolveModelWithRegistry } from "./model.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

const ANTHROPIC_OPUS_TEMPLATE = buildForwardCompatTemplate({
  id: "claude-opus-4-5",
  name: "Claude Opus 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
});

const ANTHROPIC_OPUS_EXPECTED = {
  provider: "anthropic",
  id: "claude-opus-4-6",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
};

const ANTHROPIC_SONNET_TEMPLATE = buildForwardCompatTemplate({
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
});

const ANTHROPIC_SONNET_EXPECTED = {
  provider: "anthropic",
  id: "claude-sonnet-4-6",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
};

const ZAI_REGISTRY_ENTRIES = [
  {
    provider: "zai",
    modelId: "glm-4.7",
    model: buildForwardCompatTemplate({
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      maxTokens: 131072,
    }),
  },
] as const;

function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "zai", "openai-codex"],
  });
}

function createRegistry(
  entries: Array<{ provider: string; modelId: string; model: Record<string, unknown> }>,
) {
  return {
    find(provider: string, modelId: string) {
      const match = entries.find(
        (entry) => entry.provider === provider && entry.modelId === modelId,
      );
      return match?.model ?? null;
    },
  } as never;
}

function runAnthropicOpusForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result: resolveModelWithRegistry({
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentDir: "/tmp/agent",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-opus-4-5",
          model: ANTHROPIC_OPUS_TEMPLATE,
        },
      ]),
      runtimeHooks: createRuntimeHooks(),
    }),
    expectedModel: ANTHROPIC_OPUS_EXPECTED,
  });
}

function runAnthropicSonnetForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result: resolveModelWithRegistry({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      agentDir: "/tmp/agent",
      modelRegistry: createRegistry([
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-5",
          model: ANTHROPIC_SONNET_TEMPLATE,
        },
      ]),
      runtimeHooks: createRuntimeHooks(),
    }),
    expectedModel: ANTHROPIC_SONNET_EXPECTED,
  });
}

function runZaiForwardCompatFallback(modelId: string) {
  const result = resolveModelWithRegistry({
    provider: "zai",
    modelId,
    agentDir: "/tmp/agent",
    modelRegistry: createRegistry(
      ZAI_REGISTRY_ENTRIES.map((entry) => ({
        provider: entry.provider,
        modelId: entry.modelId,
        model: entry.model,
      })),
    ),
    runtimeHooks: createRuntimeHooks(),
  });
  expectResolvedForwardCompatFallbackWithRegistryResult({
    result,
    expectedModel: {
      provider: "zai",
      id: modelId,
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
    },
  });
}

describe("resolveModel forward-compat tail", () => {
  it(
    "builds an anthropic forward-compat fallback for claude-opus-4-6",
    runAnthropicOpusForwardCompatFallback,
  );

  it(
    "builds an anthropic forward-compat fallback for claude-sonnet-4-6",
    runAnthropicSonnetForwardCompatFallback,
  );

  it("builds a zai forward-compat fallback for glm-5", () => {
    runZaiForwardCompatFallback("glm-5");
  });

  it("builds a zai forward-compat fallback for glm-5.1", () => {
    runZaiForwardCompatFallback("glm-5.1");
  });
});
