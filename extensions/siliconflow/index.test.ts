import { describe, expect, it } from "vitest";
import { resolveProviderPluginChoice } from "../../src/plugins/provider-auth-choice.runtime.js";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import siliconflowPlugin from "./index.js";

describe("siliconflow provider plugin", () => {
  it("registers SiliconFlow with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(siliconflowPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "siliconflow-api-key",
    });

    expect(provider.id).toBe("siliconflow");
    expect(provider.label).toBe("SiliconFlow");
    expect(provider.envVars).toEqual(["SILICONFLOW_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    expect(resolved).not.toBeNull();
    expect(resolved?.provider.id).toBe("siliconflow");
    expect(resolved?.method.id).toBe("api-key");
  });

  it("builds the static SiliconFlow model catalog", async () => {
    const provider = await registerSingleProviderPlugin(siliconflowPlugin);
    expect(provider.catalog).toBeDefined();

    const catalog = await provider.catalog!.run({
      config: {},
      env: {},
      resolveProviderApiKey: () => ({ apiKey: "test-key" }),
      resolveProviderAuth: () => ({
        apiKey: "test-key",
        mode: "api_key",
        source: "env",
      }),
    } as never);

    expect(catalog && "provider" in catalog).toBe(true);
    if (!catalog || !("provider" in catalog)) {
      throw new Error("expected single-provider catalog");
    }

    expect(catalog.provider.api).toBe("openai-completions");
    expect(catalog.provider.baseUrl).toBe("https://api.siliconflow.cn/v1");
    expect(catalog.provider.models?.map((model) => model.id)).toEqual([
      "Qwen/Qwen2.5-7B-Instruct",
      "Qwen/Qwen2.5-72B-Instruct",
      "deepseek-ai/DeepSeek-V3",
      "deepseek-ai/DeepSeek-R1",
    ]);
    expect(
      catalog.provider.models?.find((model) => model.id === "deepseek-ai/DeepSeek-R1")?.reasoning,
    ).toBe(true);
  });

  it("publishes configured SiliconFlow models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(siliconflowPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              siliconflow: {
                models: [
                  {
                    id: "Qwen/Qwen2.5-7B-Instruct",
                    name: "Qwen2.5-7B-Instruct",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 131072,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "siliconflow",
        id: "Qwen/Qwen2.5-7B-Instruct",
        name: "Qwen2.5-7B-Instruct",
        input: ["text"],
        reasoning: false,
        contextWindow: 131072,
      },
    ]);
  });
});
