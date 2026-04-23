import { describe, expect, it } from "vitest";
import { buildNvidiaProvider, normalizeNvidiaModelId } from "./provider-catalog.js";

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2.5",
      "minimaxai/minimax-m2.5",
      "z-ai/glm5",
    ]);
  });

  it("normalizes NVIDIA model ids to the full upstream namespace", () => {
    expect(normalizeNvidiaModelId("nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    expect(normalizeNvidiaModelId("moonshotai/kimi-k2.5")).toBe("nvidia/moonshotai/kimi-k2.5");
    expect(normalizeNvidiaModelId("nvidia/nemotron-3-super-120b-a12b")).toBe(
      "nvidia/nemotron-3-super-120b-a12b",
    );
  });
});
