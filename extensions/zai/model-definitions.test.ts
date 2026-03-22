import { describe, expect, it } from "vitest";
import { buildZaiModelDefinition, ZAI_DEFAULT_COST } from "./model-definitions.js";

describe("zai model definitions", () => {
  it("uses current Pi metadata for the default GLM-5 model", () => {
    expect(buildZaiModelDefinition({ id: "glm-5" })).toMatchObject({
      id: "glm-5",
      reasoning: true,
      input: ["text"],
      contextWindow: 204800,
      maxTokens: 131072,
      cost: ZAI_DEFAULT_COST,
    });
  });

  it("publishes newer GLM 4.5/4.6 family metadata from Pi", () => {
    expect(buildZaiModelDefinition({ id: "glm-4.6v" })).toMatchObject({
      id: "glm-4.6v",
      input: ["text", "image"],
      contextWindow: 128000,
      maxTokens: 32768,
      cost: { input: 0.3, output: 0.9, cacheRead: 0, cacheWrite: 0 },
    });
    expect(buildZaiModelDefinition({ id: "glm-4.5-air" })).toMatchObject({
      id: "glm-4.5-air",
      input: ["text"],
      contextWindow: 131072,
      maxTokens: 98304,
      cost: { input: 0.2, output: 1.1, cacheRead: 0.03, cacheWrite: 0 },
    });
  });
});
