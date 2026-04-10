import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qwenPlugin from "./index.js";
import { QWEN_36_PLUS_MODEL_ID, QWEN_CN_BASE_URL } from "./models.js";

describe("qwen provider hooks (Coding Plan vs explicit qwen3.6-plus)", () => {
  it("does not register normalizeConfig (no user-config mutation hook)", async () => {
    const provider = await registerSingleProviderPlugin(qwenPlugin);
    expect(provider.normalizeConfig).toBeUndefined();
  });

  it("suppresses qwen3.6-plus from built-in resolution on Coding Plan when not explicitly configured", async () => {
    const provider = await registerSingleProviderPlugin(qwenPlugin);
    const result = provider.suppressBuiltInModel?.({
      env: process.env,
      provider: "qwen",
      modelId: QWEN_36_PLUS_MODEL_ID,
      baseUrl: QWEN_CN_BASE_URL,
      config: undefined,
    });
    expect(result?.suppress).toBe(true);
    expect(result?.errorMessage).toContain("qwen3.6-plus");
  });

  it("does not suppress qwen3.6-plus when the model is explicitly listed under qwen provider config", async () => {
    const provider = await registerSingleProviderPlugin(qwenPlugin);
    const result = provider.suppressBuiltInModel?.({
      env: process.env,
      provider: "qwen",
      modelId: QWEN_36_PLUS_MODEL_ID,
      baseUrl: QWEN_CN_BASE_URL,
      config: {
        models: {
          providers: {
            qwen: {
              baseUrl: QWEN_CN_BASE_URL,
              api: "openai-completions",
              models: [
                {
                  id: QWEN_36_PLUS_MODEL_ID,
                  name: QWEN_36_PLUS_MODEL_ID,
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1_000_000,
                  maxTokens: 65_536,
                },
              ],
            },
          },
        },
      },
    });
    expect(result).toBeUndefined();
  });

  it("does not suppress when explicit listing uses legacy modelstudio provider key", async () => {
    const provider = await registerSingleProviderPlugin(qwenPlugin);
    const result = provider.suppressBuiltInModel?.({
      env: process.env,
      provider: "qwen",
      modelId: QWEN_36_PLUS_MODEL_ID,
      baseUrl: QWEN_CN_BASE_URL,
      config: {
        models: {
          providers: {
            modelstudio: {
              baseUrl: QWEN_CN_BASE_URL,
              models: [{ id: QWEN_36_PLUS_MODEL_ID }],
            },
          },
        },
      },
    } as never);
    expect(result).toBeUndefined();
  });
});
