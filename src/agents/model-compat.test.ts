import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeModelCompat } from "./model-compat.js";

const baseModel = (): Model<Api> =>
  ({
    id: "glm-4.7",
    name: "GLM-4.7",
    api: "openai-completions",
    provider: "zai",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  }) as Model<Api>;

describe("normalizeModelCompat", () => {
  it("forces supportsDeveloperRole off for z.ai models", () => {
    const model = baseModel();
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(
      (normalized.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole,
    ).toBe(false);
  });

  it("leaves non-zai models untouched", () => {
    const model = {
      ...baseModel(),
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });

  it("does not override explicit z.ai compat false", () => {
    const model = baseModel();
    model.compat = { supportsDeveloperRole: false };
    const normalized = normalizeModelCompat(model);
    expect(
      (normalized.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole,
    ).toBe(false);
  });

  it("forces supportsDeveloperRole off for Aliyun/Dashscope models", () => {
    const model = {
      ...baseModel(),
      id: "qwen3-max",
      name: "qwen3-max",
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces supportsDeveloperRole off for Qwen Portal models", () => {
    const model = {
      ...baseModel(),
      id: "coder-model",
      name: "coder-model",
      provider: "qwen-portal",
      baseUrl: "https://portal.qwen.ai/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces supportsDeveloperRole off for Qianfan/Baidu models", () => {
    const model = {
      ...baseModel(),
      id: "deepseek-v3.2",
      name: "deepseek-v3.2",
      provider: "qianfan",
      baseUrl: "https://qianfan.baidubce.com/v2",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces supportsDeveloperRole off for openai-responses API on unsupported providers", () => {
    const model = {
      ...baseModel(),
      api: "openai-responses" as const,
      provider: "aliyun",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("leaves Anthropic models untouched", () => {
    const model = {
      ...baseModel(),
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat).toBeUndefined();
  });
});
