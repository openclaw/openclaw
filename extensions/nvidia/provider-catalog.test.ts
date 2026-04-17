import { describe, expect, it } from "vitest";
import { buildNvidiaProvider, NVIDIA_CATALOGED_MODELS } from "./provider-catalog.js";
import { NVIDIA_BASE_URL, NVIDIA_CATALOGED_MODELS as MODELS_FROM_MODELS } from "./models.js";

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", async () => {
    const provider = await buildNvidiaProvider();

    expect(provider.baseUrl).toBe(NVIDIA_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual(
      MODELS_FROM_MODELS.map((m) => m.id),
    );
  });

  it("has correct default model properties", async () => {
    const provider = await buildNvidiaProvider();
    const defaultModel = provider.models[0];

    expect(defaultModel.id).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(defaultModel.name).toBe("NVIDIA Nemotron 3 Super 120B");
    expect(defaultModel.reasoning).toBe(false);
    expect(defaultModel.input).toEqual(["text"]);
    expect(defaultModel.contextWindow).toBe(262144);
    expect(defaultModel.maxTokens).toBe(8192);
    expect(defaultModel.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("uses cataloged models in test environment", async () => {
    const provider = await buildNvidiaProvider();

    expect(provider.models.length).toBe(MODELS_FROM_MODELS.length);
    expect(provider.models.map((m) => m.id)).toEqual(MODELS_FROM_MODELS.map((m) => m.id));
  });

  it("catalog has NVIDIA-owned models only", () => {
    const nvidiaOwned = MODELS_FROM_MODELS.filter((m) => m.id.startsWith("nvidia/"));
    expect(nvidiaOwned.length).toBeGreaterThan(0);
    expect(nvidiaOwned.map((m) => m.id)).toContain("nvidia/nemotron-3-super-120b-a12b");
    expect(nvidiaOwned.map((m) => m.id)).toContain("nvidia/nemotron-4-340b-instruct");
  });
});
