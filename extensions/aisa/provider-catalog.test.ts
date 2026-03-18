import { describe, expect, it } from "vitest";
import {
  AISA_BASE_URL,
  AISA_DEFAULT_CONTEXT_WINDOW,
  AISA_DEFAULT_MAX_TOKENS,
  AISA_DEFAULT_MODEL_ID,
  buildAisaProvider,
} from "./provider-catalog.js";

describe("buildAisaProvider", () => {
  it("returns correct base URL and API type", () => {
    const provider = buildAisaProvider();
    expect(provider.baseUrl).toBe("https://api.aisa.one/v1");
    expect(provider.api).toBe("openai-completions");
  });

  it("includes six models", () => {
    const provider = buildAisaProvider();
    expect(provider.models).toHaveLength(6);
    const ids = provider.models.map((m) => m.id);
    expect(ids).toContain("kimi-k2.5");
    expect(ids).toContain("qwen3-max");
    expect(ids).toContain("minimax-m2.1");
    expect(ids).toContain("glm-5");
    expect(ids).toContain("deepseek-v3.2");
    expect(ids).toContain("seed-1-8-251228");
  });

  it("marks vision models correctly", () => {
    const provider = buildAisaProvider();
    const visionModels = provider.models.filter((m) => m.input?.includes("image"));
    const visionIds = visionModels.map((m) => m.id);
    expect(visionIds).toContain("qwen3-max");
    expect(visionIds).toContain("glm-5");
    expect(visionIds).not.toContain("kimi-k2.5");
    expect(visionIds).not.toContain("minimax-m2.1");
  });

  it("marks reasoning models correctly", () => {
    const provider = buildAisaProvider();
    const reasoningModels = provider.models.filter((m) => m.reasoning);
    const reasoningIds = reasoningModels.map((m) => m.id);
    expect(reasoningIds).toContain("kimi-k2.5");
    expect(reasoningIds).toContain("qwen3-max");
    expect(reasoningIds).toContain("glm-5");
    expect(reasoningIds).not.toContain("deepseek-v3.2");
    expect(reasoningIds).not.toContain("seed-1-8-251228");
    expect(reasoningIds).not.toContain("minimax-m2.1");
  });

  it("exports expected constants", () => {
    expect(AISA_BASE_URL).toBe("https://api.aisa.one/v1");
    expect(AISA_DEFAULT_MODEL_ID).toBe("kimi-k2.5");
    expect(AISA_DEFAULT_CONTEXT_WINDOW).toBe(256_000);
    expect(AISA_DEFAULT_MAX_TOKENS).toBe(32_768);
  });
});
