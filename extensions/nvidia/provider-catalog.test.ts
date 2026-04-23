import { describe, expect, it } from "vitest";
import { buildNimProvider } from "./provider-catalog.js";

describe("nvidia nim provider catalog", () => {
  it("builds the bundled NVIDIA NIM provider defaults", () => {
    const provider = buildNimProvider();

    expect(provider.baseUrl).toBe("https://integrate.api.nvidia.com/v1");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models.map((model) => model.id)).toEqual([
      "nvidia/llama-3.1-nemotron-70b-instruct",
      "meta/llama-3.1-405b-instruct",
      "meta/llama-3.1-70b-instruct",
      "mistralai/mixtral-8x22b-instruct-v0.1",
    ]);
  });
});
