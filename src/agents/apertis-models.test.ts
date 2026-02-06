import { describe, expect, it } from "vitest";
import {
  discoverApertisModels,
  isApertisReasoningModel,
  isApertisVisionModel,
  APERTIS_DEFAULT_COST,
} from "./apertis-models.js";

describe("apertis heuristic detection", () => {
  it("detects reasoning models by ID pattern", () => {
    expect(isApertisReasoningModel("deepseek-r1-latest")).toBe(true);
    expect(isApertisReasoningModel("o1-preview")).toBe(true);
    expect(isApertisReasoningModel("o3-mini")).toBe(true);
    expect(isApertisReasoningModel("o4-mini")).toBe(true);
    expect(isApertisReasoningModel("qwen-thinking-32b")).toBe(true);
    expect(isApertisReasoningModel("claude-opus-4-5")).toBe(false);
    expect(isApertisReasoningModel("gpt-4o")).toBe(false);
  });

  it("detects vision models by ID pattern", () => {
    expect(isApertisVisionModel("gpt-4o")).toBe(true);
    expect(isApertisVisionModel("gpt-4o-mini")).toBe(true);
    expect(isApertisVisionModel("qwen-vl-72b")).toBe(true);
    expect(isApertisVisionModel("llava-vision-7b")).toBe(true);
    expect(isApertisVisionModel("claude-opus-4-5")).toBe(false);
    expect(isApertisVisionModel("deepseek-r1")).toBe(false);
  });
});

describe("APERTIS_DEFAULT_COST", () => {
  it("has zero costs for all fields", () => {
    expect(APERTIS_DEFAULT_COST).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});

describe("discoverApertisModels", () => {
  it("returns empty array in test environment", async () => {
    // VITEST env var is set, so discovery is skipped
    const models = await discoverApertisModels();
    expect(models).toEqual([]);
  });
});
