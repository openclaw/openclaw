import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveModelWithRegistry } from "./model.js";

describe("resolveModelWithRegistry image input preservation", () => {
  it("preserves configured image capability for custom provider fallback models", () => {
    const cfg = {
      models: {
        providers: {
          litellm: {
            baseUrl: "http://localhost:4000",
            api: "openai-completions",
            models: [
              {
                id: "azure-gpt-5-mini",
                name: "Azure GPT-5 Mini",
                reasoning: false,
                input: ["text", "image"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const modelRegistry = {
      find: () => null,
    } as { find: (provider: string, modelId: string) => null };

    const model = resolveModelWithRegistry({
      provider: "litellm",
      modelId: "azure-gpt-5-mini",
      modelRegistry: modelRegistry as never,
      cfg,
    });

    expect(model).toBeDefined();
    expect(model?.provider).toBe("litellm");
    expect(model?.id).toBe("azure-gpt-5-mini");
    expect(model?.input).toEqual(["text", "image"]);
    expect(model?.api).toBe("openai-completions");
    expect(model?.baseUrl).toBe("http://localhost:4000");
  });
});
