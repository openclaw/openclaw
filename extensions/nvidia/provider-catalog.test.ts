import { describe, expect, it } from "vitest";
import { buildNvidiaProvider } from "./provider-catalog.js";

describe("nvidia provider catalog", () => {
  it("builds the bundled NVIDIA provider defaults", () => {
    const provider = buildNvidiaProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "meta/llama-3.3-70b-instruct",
      "nvidia/mistral-nemo-minitron-8b-8k-instruct",
    ]);
  });
});
