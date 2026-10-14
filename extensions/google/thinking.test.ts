// Google tests cover thinking plugin behavior.
import { describe, expect, it } from "vitest";
import {
  isGoogleGemini3ThinkingLevelModel,
  resolveGoogleGemini3ThinkingLevel,
  sanitizeGoogleThinkingPayload,
} from "./thinking-api.js";
import { buildGoogleGenerativeAiParams } from "./transport-stream.js";

function buildGeminiUserParams(
  model: Partial<Parameters<typeof buildGoogleGenerativeAiParams>[0]> = {},
  options?: Record<string, unknown>,
) {
  return buildGoogleGenerativeAiParams(
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      api: "google-generative-ai",
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
      ...model,
    },
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    options as Parameters<typeof buildGoogleGenerativeAiParams>[2],
  );
}

describe("Google transport thinking config", () => {
  it.each([
    {
      name: "custom model has no negative fallback budget",
      model: {
        id: "custom-gemini-model",
        provider: "custom-google",
        baseUrl: "https://proxy.example.com/gemini/v1beta",
      },
      options: { reasoning: "medium" },
      expected: { includeThoughts: true },
    },
    {
      name: "non-reasoning model omits thinking",
      model: { id: "gemma-4-26b-a4b-it", reasoning: false },
      options: { reasoning: "medium" },
      expected: undefined,
    },
    {
      name: "Gemini 2.5 Pro omits disabled thinking",
      model: {},
      options: { maxTokens: 128 },
      expected: undefined,
    },
    {
      name: "Gemini 2.5 Pro strips zero budget but keeps thoughts",
      model: {},
      options: { thinking: { enabled: true, budgetTokens: 0 } },
      expected: { includeThoughts: true },
    },
    ...[
      { id: "gemini-pro-latest", thinkingLevel: "LOW" },
      { id: "gemini-flash-lite-latest", thinkingLevel: "MINIMAL" },
      { id: "gemini-3.6-flash", thinkingLevel: "MINIMAL" },
      { id: "gemini-3.7-flash", thinkingLevel: "LOW" },
      { id: "gemini-3.8-flash", thinkingLevel: "LOW" },
      { id: "gemini-4-argon", thinkingLevel: "LOW" },
    ].map(({ id, thinkingLevel }) => ({
      name: `${id} disabled thinking floor`,
      model: { id },
      options: { maxTokens: 128 },
      expected: { thinkingLevel },
    })),
    {
      name: "Gemini 3.8 Flash floors minimal thinking at LOW",
      model: { id: "gemini-3.8-flash" },
      options: { reasoning: "minimal" },
      expected: { includeThoughts: true, thinkingLevel: "LOW" },
    },
    {
      name: "explicit Gemini 3 budget becomes a level",
      model: { id: "gemini-3-flash-preview" },
      options: { thinking: { enabled: true, budgetTokens: 8192 } },
      expected: { includeThoughts: true, thinkingLevel: "MEDIUM" },
    },
    {
      name: "adaptive Gemini 3 uses dynamic defaults",
      model: { id: "gemini-3-flash-preview" },
      options: { reasoning: "adaptive" },
      expected: { includeThoughts: true },
    },
    ...[
      ["minimal", "LOW"],
      ["low", "LOW"],
      ["medium", "MEDIUM"],
      ["high", "HIGH"],
      ["max", "HIGH"],
      ["adaptive", undefined],
    ].map(([reasoning, thinkingLevel]) => ({
      name: `Gemini 4 ${reasoning} thinking`,
      model: { id: "gemini-4-argon" },
      options: { reasoning },
      expected: { includeThoughts: true, ...(thinkingLevel ? { thinkingLevel } : {}) },
    })),
    {
      name: "adaptive Gemini 2.5 uses a dynamic budget",
      model: { id: "gemini-2.5-flash" },
      options: { reasoning: "adaptive" },
      expected: { includeThoughts: true, thinkingBudget: -1 },
    },
    {
      name: "Gemini 3 Pro normalizes the explicit minimum level",
      model: { id: "gemini-3.1-pro-preview" },
      options: { thinking: { enabled: true, level: "MINIMAL" } },
      expected: { includeThoughts: true, thinkingLevel: "LOW" },
    },
    ...[
      { id: "gemini-2.5-flash-lite", reasoning: "minimal", thinkingBudget: 512 },
      { id: "gemini-2.5-flash-lite", reasoning: "low", thinkingBudget: 2048 },
      { id: "gemini-2.5-flash", reasoning: "minimal", thinkingBudget: 128 },
      { id: "gemini-2.5-pro", reasoning: "minimal", thinkingBudget: 128 },
      { id: "gemini-2.5-pro", reasoning: "medium", thinkingBudget: 8192 },
    ].map(({ id, reasoning, thinkingBudget }) => ({
      name: `${id} ${reasoning} budget`,
      model: { id },
      options: { reasoning },
      expected: { includeThoughts: true, thinkingBudget },
    })),
  ])("builds thinking config: $name", ({ model, options, expected }) => {
    const config = buildGeminiUserParams(model, options).generationConfig ?? {};
    if (expected === undefined) {
      expect(config).not.toHaveProperty("thinkingConfig");
    } else {
      expect(config.thinkingConfig).toStrictEqual(expected);
    }
    if ("maxTokens" in options) {
      expect(config).toHaveProperty("maxOutputTokens", options.maxTokens);
    }
  });
});

describe("google thinking policy", () => {
  it.each([
    ["gemini-4-argon", true],
    ["google/gemini-4-argon", true],
    ["gemini-4", true],
    ["gemini-4.1-argon", true],
    ["gemini-40-argon", false],
    ["gemma-4", false],
    ["gemma4", false],
  ] as const)("recognizes thinking-level family %s as %s", (modelId, expected) => {
    expect(isGoogleGemini3ThinkingLevelModel(modelId)).toBe(expected);
  });

  it.each([
    ["off", "LOW"],
    ["minimal", "LOW"],
    ["low", "LOW"],
    ["medium", "HIGH"],
    ["adaptive", undefined],
    ["high", "HIGH"],
    ["xhigh", "HIGH"],
  ] as const)("maps Gemini 3 Pro thinking level %s to %s", (thinkingLevel, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-3.1-pro-preview",
        thinkingLevel,
      }),
    ).toBe(expected);
  });

  it.each([
    [2048, "LOW"],
    [2049, "HIGH"],
  ] as const)("maps Gemini 3 Pro budget %s to %s", (thinkingBudget, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId: "gemini-pro-latest",
        thinkingBudget,
      }),
    ).toBe(expected);
  });

  it.each([
    ["gemini-flash-latest", "off", "MINIMAL"],
    ["gemini-flash-latest", "minimal", "MINIMAL"],
    ["gemini-flash-latest", "low", "LOW"],
    ["gemini-flash-latest", "medium", "MEDIUM"],
    ["gemini-flash-latest", "adaptive", undefined],
    ["gemini-flash-latest", "high", "HIGH"],
    ["gemini-flash-latest", "xhigh", "HIGH"],
    ["gemini-3.6-flash", "off", "MINIMAL"],
    ["gemini-3.6-flash", "minimal", "MINIMAL"],
    ["gemini-3.7-flash", "off", "LOW"],
    ["gemini-3.7-flash", "minimal", "LOW"],
    ["gemini-3.8-flash", "off", "LOW"],
    ["gemini-3.8-flash", "minimal", "LOW"],
  ] as const)("maps %s thinking level %s to %s", (modelId, thinkingLevel, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId,
        thinkingLevel,
      }),
    ).toBe(expected);
  });

  it.each([
    ["gemini-3.1-flash-lite", -1, undefined],
    ["gemini-3.1-flash-lite", 0, "MINIMAL"],
    ["gemini-3.1-flash-lite", 2048, "LOW"],
    ["gemini-3.1-flash-lite", 8192, "MEDIUM"],
    ["gemini-3.1-flash-lite", 8193, "HIGH"],
    ["gemini-3.6-flash", 0, "MINIMAL"],
    ["gemini-3.7-flash", 0, "LOW"],
    ["gemini-3.8-flash", 0, "LOW"],
  ] as const)("maps %s budget %s to %s", (modelId, thinkingBudget, expected) => {
    expect(
      resolveGoogleGemini3ThinkingLevel({
        modelId,
        thinkingBudget,
      }),
    ).toBe(expected);
  });

  it("rewrites Gemini 3 thinking budgets to thinkingLevel", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 8193, includeThoughts: true },
      },
    };

    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    });

    expect(payload.generationConfig.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });
});
