import { vi } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.js";
import { discoverModels } from "../pi-model-discovery.js";

export const makeModel = (id: string): ModelDefinitionConfig => ({
  id,
  name: id,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1,
  maxTokens: 1,
});

export const OPENAI_CODEX_TEMPLATE_MODEL = {
  id: "gpt-5.2-codex",
  name: "GPT-5.2 Codex",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text", "image"] as const,
  cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};

export function mockOpenAICodexTemplateModel(): void {
  mockDiscoveredModel({
    provider: "openai-codex",
    modelId: "gpt-5.2-codex",
    templateModel: OPENAI_CODEX_TEMPLATE_MODEL,
  });
}

export function buildOpenAICodexForwardCompatExpectation(
  id: string = "gpt-5.3-codex",
): Partial<typeof OPENAI_CODEX_TEMPLATE_MODEL> & { provider: string; id: string } {
  return {
    provider: "openai-codex",
    id,
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    contextWindow: 272000,
    maxTokens: 128000,
  };
}

export function resetMockDiscoverModels(): void {
  vi.mocked(discoverModels).mockReturnValue({
    find: vi.fn(() => null),
  } as unknown as ReturnType<typeof discoverModels>);
}

export function mockDiscoveredModel(params: {
  provider: string;
  modelId: string;
  templateModel: unknown;
}): void {
  vi.mocked(discoverModels).mockReturnValue({
    find: vi.fn((provider: string, modelId: string) => {
      if (provider === params.provider && modelId === params.modelId) {
        return params.templateModel;
      }
      return null;
    }),
  } as unknown as ReturnType<typeof discoverModels>);
}
