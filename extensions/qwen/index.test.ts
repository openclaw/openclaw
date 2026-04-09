import { describe, expect, it } from "vitest";
import { registerSingleProviderPlugin } from "../../test/helpers/plugins/plugin-registration.js";
import qwenPlugin from "./index.js";
import { QWEN_36_PLUS_MODEL_ID, QWEN_CN_BASE_URL } from "./models.js";

describe("qwen provider config normalization", () => {
  it("does not drop explicitly configured qwen3.6-plus on Coding Plan endpoints", async () => {
    const provider = await registerSingleProviderPlugin(qwenPlugin);

    const normalized = provider.normalizeConfig?.({
      provider: "qwen",
      providerConfig: {
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
    } as never);

    // The provider intentionally advertises qwen3.6-plus only on Standard endpoints
    // in its built-in catalog, but users should still be able to opt-in explicitly.
    expect(normalized).toBeUndefined();
  });
});
