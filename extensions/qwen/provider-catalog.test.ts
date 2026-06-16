// Qwen tests cover provider catalog plugin behavior.
import { describe, expect, it } from "vitest";
import {
  applyQwenNativeStreamingUsageCompat,
  QWEN_TOKEN_PLAN_CN_BASE_URL,
  QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID,
  QWEN_TOKEN_PLAN_GLOBAL_BASE_URL,
  buildQwenTokenPlanProvider,
  buildQwenProvider,
  QWEN_BASE_URL,
  QWEN_STANDARD_GLOBAL_BASE_URL,
  QWEN_DEFAULT_MODEL_ID,
  resolveQwenTokenPlanBaseUrl,
} from "./api.js";

type QwenProvider = ReturnType<typeof buildQwenProvider>;

function getQwenModelIds(provider: QwenProvider): string[] {
  return provider.models.map((model) => model.id);
}

describe("qwen provider catalog", () => {
  it("builds the bundled Qwen provider defaults", () => {
    const provider = buildQwenProvider();

    expect(provider.baseUrl).toBe(QWEN_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    const modelIds = getQwenModelIds(provider);
    expect(modelIds.length).toBeGreaterThan(0);
    expect(modelIds).toContain(QWEN_DEFAULT_MODEL_ID);
    expect(modelIds).not.toContain("qwen3.6-plus");
  });

  it("only advertises qwen3.6-plus on Standard endpoints", () => {
    const coding = buildQwenProvider({ baseUrl: QWEN_BASE_URL });
    const codingTrailingDot = buildQwenProvider({
      baseUrl: " https://coding-intl.dashscope.aliyuncs.com./v1 ",
    });
    const standard = buildQwenProvider({ baseUrl: QWEN_STANDARD_GLOBAL_BASE_URL });

    expect(getQwenModelIds(coding)).not.toContain("qwen3.6-plus");
    expect(getQwenModelIds(codingTrailingDot)).not.toContain("qwen3.6-plus");
    expect(getQwenModelIds(standard)).toContain("qwen3.6-plus");
  });

  it("opts native Qwen baseUrls into streaming usage only inside the extension", () => {
    const nativeProvider = applyQwenNativeStreamingUsageCompat(buildQwenProvider());
    expect(nativeProvider.models.length).toBeGreaterThan(0);
    expect(
      nativeProvider.models.every((model) => {
        if (!model.compat) {
          throw new Error(`expected Qwen model ${model.id} compat`);
        }
        return model.compat.supportsUsageInStreaming === true;
      }),
    ).toBe(true);

    const customProvider = applyQwenNativeStreamingUsageCompat({
      ...buildQwenProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      customProvider.models.some(
        (model) => model.compat && model.compat.supportsUsageInStreaming === true,
      ),
    ).toBe(false);
  });
});

describe("qwen token plan provider catalog", () => {
  it("builds the OpenAI-compatible token-plan provider on the global gateway", () => {
    const provider = buildQwenTokenPlanProvider();

    expect(provider.baseUrl).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(provider.baseUrl).toContain("/compatible-mode/v1");
    expect(provider.api).toBe("openai-completions");
    const modelIds = provider.models.map((model) => model.id);
    expect(modelIds).toContain(QWEN_TOKEN_PLAN_DEFAULT_MODEL_ID);
    expect(modelIds).toContain("qwen3.7-max");
    expect(modelIds).toContain("MiniMax-M2.5");
    // Chat-only catalog: image-generation models are intentionally excluded.
    expect(modelIds).not.toContain("qwen-image-2.0");
    expect(modelIds).not.toContain("wan2.7-image");
  });

  it("selects the Beijing gateway for the CN region", () => {
    expect(resolveQwenTokenPlanBaseUrl("global")).toBe(QWEN_TOKEN_PLAN_GLOBAL_BASE_URL);
    expect(resolveQwenTokenPlanBaseUrl("cn")).toBe(QWEN_TOKEN_PLAN_CN_BASE_URL);

    const cnProvider = buildQwenTokenPlanProvider({ baseUrl: QWEN_TOKEN_PLAN_CN_BASE_URL });
    expect(cnProvider.baseUrl).toBe(QWEN_TOKEN_PLAN_CN_BASE_URL);
    expect(cnProvider.api).toBe("openai-completions");
  });

  it("ships all 12 reasoning-capable chat models (thinkingFormat left to detection)", () => {
    const provider = buildQwenTokenPlanProvider();

    expect(provider.models).toHaveLength(12);
    expect(provider.models.every((model) => model.reasoning)).toBe(true);
    // No hardcoded compat: detection resolves Qwen/ModelStudio to thinkingFormat
    // "openai", matching the rest of the qwen provider.
    expect(provider.models.every((model) => model.compat === undefined)).toBe(true);
  });
});
