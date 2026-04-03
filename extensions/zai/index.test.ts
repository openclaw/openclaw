import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import plugin from "./index.js";

describe("zai provider plugin", () => {
  it("resolves persisted GLM-5 family models with provider-owned metadata", () => {
    const provider = registerSingleProviderPlugin(plugin);
    const template = {
      id: "glm-4.7",
      name: "GLM-4.7",
      provider: "zai",
      api: "openai-completions",
      baseUrl: "https://api.z.ai/api/paas/v4",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.6, output: 2.2, cacheRead: 0.11, cacheWrite: 0 },
      contextWindow: 204800,
      maxTokens: 131072,
    };

    const cases = [
      {
        modelId: "glm-5.1",
        expected: {
          input: ["text"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
      {
        modelId: "glm-5v-turbo",
        expected: {
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 202800,
          maxTokens: 131100,
        },
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        provider.resolveDynamicModel?.({
          provider: "zai",
          modelId: testCase.modelId,
          modelRegistry: { find: () => template },
        } as never),
      ).toMatchObject({
        provider: "zai",
        api: "openai-completions",
        baseUrl: "https://api.z.ai/api/paas/v4",
        id: testCase.modelId,
        ...testCase.expected,
      });
    }
  });
});
