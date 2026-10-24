import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function modelConfig(
  provider: string,
  id: string,
  limits: Partial<Pick<ModelDefinitionConfig, "contextWindow" | "contextTokens">>,
): OpenClawConfig {
  const model: ModelDefinitionConfig = {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...limits,
  };
  return {
    models: { providers: { [provider]: { baseUrl: "https://example.invalid", models: [model] } } },
  };
}
