import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { vi } from "vitest";
import type { LlamaServerDiscoveryResult } from "./discovery.js";

export const discoverMock = vi.hoisted(() => vi.fn());
export const runtimeApiKeyMock = vi.hoisted(() => vi.fn());
vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

export function modelConfig(overrides: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id: "qwen/model:Q4_K_M",
    name: "qwen/model:Q4_K_M",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 8192,
    ...overrides,
  };
}

export function successfulDiscovery(
  origin = "http://localhost:8080",
  overrides: Partial<ModelDefinitionConfig> = {},
): Extract<LlamaServerDiscoveryResult, { kind: "success" }> {
  return {
    kind: "success" as const,
    endpoint: { origin, inferenceBaseUrl: `${origin}/v1` },
    models: [
      {
        config: modelConfig({ contextTokens: 32768, ...overrides }),
        status: "loaded" as const,
        failed: false,
      },
    ],
  };
}
