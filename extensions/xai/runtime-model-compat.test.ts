import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

function buildModel(overrides: { reasoning: boolean; id?: string }) {
  return {
    id: overrides.id ?? "grok-4.3",
    api: "openai-responses",
    provider: "xai",
    baseUrl: "https://api.x.ai/v1",
    reasoning: overrides.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  } as Model<"openai-responses"> & { reasoning: boolean };
}

describe("applyXaiRuntimeModelCompat", () => {
  it("maps thinking levels to reasoning_effort values for reasoning-capable Grok models", () => {
    const model = applyXaiRuntimeModelCompat(buildModel({ reasoning: true }));

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
    });
  });

  it("keeps every level mapped to null on non-reasoning xAI models", () => {
    const model = applyXaiRuntimeModelCompat(
      buildModel({ reasoning: false, id: "grok-4-fast-non-reasoning" }),
    );

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    });
  });

  it("treats undefined reasoning flag as non-reasoning to preserve safe defaults", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-legacy",
      api: "openai-completions",
      provider: "xai",
    } as unknown as Model<"openai-completions">);

    expect(model.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
    });
  });

  it("forwards the xAI tool-schema compat patch alongside the level map", () => {
    const model = applyXaiRuntimeModelCompat(buildModel({ reasoning: true }));

    expect(model.compat).toMatchObject({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
  });
});
