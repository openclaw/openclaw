import { beforeEach, describe, it, vi } from "vitest";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

vi.mock("../../plugins/provider-runtime.js", () => {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["anthropic", "zai", "openai-codex"],
  });
});

import { clearProviderRuntimeHookCache } from "../../plugins/provider-runtime.js";
import {
  buildForwardCompatTemplate,
  expectResolvedForwardCompatFallback,
  expectResolvedForwardCompatFallbackWithRegistry,
} from "./model.forward-compat.test-support.js";
import { mockDiscoveredModel, resetMockDiscoverModels } from "./model.test-harness.js";

beforeEach(() => {
  clearProviderRuntimeHookCache();
  resetMockDiscoverModels();
});

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

const ZAI_GLM5_CASE = {
  provider: "zai",
  id: "glm-5",
  expectedModel: {
    provider: "zai",
    id: "glm-5",
    api: "openai-completions",
    baseUrl: "https://api.z.ai/api/paas/v4",
    reasoning: true,
  },
  registryEntries: [
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
  ],
} as const;

function runAnthropicOpusForwardCompatFallback() {
  mockDiscoveredModel({
    provider: "anthropic",
    modelId: "claude-opus-4-5",
    templateModel: ANTHROPIC_OPUS_TEMPLATE,
  });

  expectResolvedForwardCompatFallback({
    provider: "anthropic",
    id: "claude-opus-4-6",
    expectedModel: ANTHROPIC_OPUS_EXPECTED,
  });
}

function runAnthropicSonnetForwardCompatFallback() {
  mockDiscoveredModel({
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    templateModel: ANTHROPIC_SONNET_TEMPLATE,
  });

  expectResolvedForwardCompatFallback({
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    expectedModel: ANTHROPIC_SONNET_EXPECTED,
  });
}

function runZaiForwardCompatFallback() {
  expectResolvedForwardCompatFallbackWithRegistry(ZAI_GLM5_CASE);
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

  it("builds a zai forward-compat fallback for glm-5", runZaiForwardCompatFallback);
});
