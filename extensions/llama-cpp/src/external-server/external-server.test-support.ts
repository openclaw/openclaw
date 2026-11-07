import type { LlamaServerDiscoveryResult } from "./discovery.js";
import type { LlamaServerDiscoveredModel } from "./models.js";

export function modelConfig(
  overrides: Partial<LlamaServerDiscoveredModel["config"]> = {},
): LlamaServerDiscoveredModel["config"] {
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
  overrides: Partial<LlamaServerDiscoveredModel["config"]> = {},
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
