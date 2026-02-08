import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { normalizeModelCompat } from "./model-compat.js";

type ThinkingCompat = { thinkingFormat?: "openai" | "zai" | "qwen" };

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
  const thinkingFormatOf = (model: Model<Api>) =>
    (model.compat as ThinkingCompat | undefined)?.thinkingFormat;

  it("forces supportsDeveloperRole off for z.ai models", () => {
    const model = baseModel();
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });

  it("forces thinkingFormat=qwen for DashScope OpenAI-compat endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(thinkingFormatOf(normalized)).toBe("qwen");
  });

  it("forces thinkingFormat=qwen for Qwen Portal OpenAI-compat endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "qwen-portal",
      baseUrl: "https://portal.qwen.ai/v1",
    };
    delete (model as { compat?: unknown }).compat;
    const normalized = normalizeModelCompat(model);
    expect(thinkingFormatOf(normalized)).toBe("qwen");
  });

  it("does not override explicit thinkingFormat for Qwen endpoints", () => {
    const model = {
      ...baseModel(),
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      compat: {
        thinkingFormat: "openai",
      },
    };
    const normalized = normalizeModelCompat(model);
    expect(thinkingFormatOf(normalized)).toBe("openai");
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
    expect(normalized.compat?.supportsDeveloperRole).toBe(false);
  });
});
