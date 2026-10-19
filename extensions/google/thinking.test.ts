import { describe, expect, it } from "vitest";
import {
  isGoogleGemini3ThinkingLevelModel,
  resolveGoogleGemini3ThinkingLevel,
  type GoogleThinkingInputLevel,
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

function configCase(
  model: string | Partial<Parameters<typeof buildGoogleGenerativeAiParams>[0]>,
  options: Record<string, unknown>,
  expected?: Record<string, unknown>,
) {
  return { model: typeof model === "string" ? { id: model } : model, options, expected };
}
const thoughts = { includeThoughts: true };

describe("Google transport thinking config", () => {
  it.each([
    configCase(
      {
        id: "custom-gemini-model",
        provider: "custom-google",
        baseUrl: "https://proxy.example.com/gemini/v1beta",
      },
      { reasoning: "medium" },
      thoughts,
    ),
    configCase({ id: "gemma-4-26b-a4b-it", reasoning: false }, { reasoning: "medium" }),
    configCase({}, { maxTokens: 128 }, { thinkingBudget: 128 }),
    configCase({}, { thinking: { enabled: true, budgetTokens: 0 } }, thoughts),
    ...[
      { id: "gemini-pro-latest", thinkingLevel: "LOW" },
      { id: "gemini-flash-lite-latest", thinkingLevel: "MINIMAL" },
      { id: "gemini-3.6-flash", thinkingLevel: "MINIMAL" },
      { id: "gemini-3.7-flash", thinkingLevel: "LOW" },
      { id: "gemini-3.8-flash", thinkingLevel: "LOW" },
      { id: "gemini-4-argon", thinkingLevel: "LOW" },
    ].map(({ id, thinkingLevel }) => configCase(id, { maxTokens: 128 }, { thinkingLevel })),
    configCase("gemini-3.8-flash", { reasoning: "minimal" }, { ...thoughts, thinkingLevel: "LOW" }),
    configCase(
      "gemini-3-flash-preview",
      { thinking: { enabled: true, budgetTokens: 8192 } },
      { ...thoughts, thinkingLevel: "MEDIUM" },
    ),
    configCase("gemini-3-flash-preview", { reasoning: "adaptive" }, thoughts),
    ...[
      ["minimal", "LOW"],
      ["low", "LOW"],
      ["medium", "MEDIUM"],
      ["high", "HIGH"],
      ["max", "HIGH"],
      ["adaptive", undefined],
    ].map(([reasoning, thinkingLevel]) =>
      configCase(
        "gemini-4-argon",
        { reasoning },
        { ...thoughts, ...(thinkingLevel ? { thinkingLevel } : {}) },
      ),
    ),
    configCase("gemini-2.5-flash", { reasoning: "adaptive" }, { ...thoughts, thinkingBudget: -1 }),
    configCase(
      "gemini-3.1-pro-preview",
      { thinking: { enabled: true, level: "MINIMAL" } },
      { ...thoughts, thinkingLevel: "LOW" },
    ),
    ...[
      { id: "gemini-2.5-flash-lite", reasoning: "minimal", thinkingBudget: 512 },
      { id: "gemini-2.5-flash-lite", reasoning: "low", thinkingBudget: 2048 },
      { id: "gemini-2.5-flash", reasoning: "minimal", thinkingBudget: 128 },
      { id: "gemini-2.5-pro", reasoning: "minimal", thinkingBudget: 128 },
      { id: "gemini-2.5-pro", reasoning: "medium", thinkingBudget: 8192 },
    ].map(({ id, reasoning, thinkingBudget }) =>
      configCase(id, { reasoning }, { ...thoughts, thinkingBudget }),
    ),
  ])("builds thinking config: $model $options", ({ model, options, expected }) => {
    const config = buildGeminiUserParams(model, options).generationConfig ?? {};
    if (expected === undefined) {
      expect(config).not.toHaveProperty("thinkingConfig");
    } else {
      expect(config.thinkingConfig).toStrictEqual(expected);
    }
  });
});

function levels(
  modelId: string,
  rows: ReadonlyArray<readonly [GoogleThinkingInputLevel, string | undefined]>,
) {
  return rows.map(([thinkingLevel, expected]) => ({ modelId, thinkingLevel, expected }));
}
function budgets(modelId: string, rows: ReadonlyArray<readonly [number, string | undefined]>) {
  return rows.map(([thinkingBudget, expected]) => ({ modelId, thinkingBudget, expected }));
}

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
    ...levels("gemini-3.1-pro-preview", [
      ["off", "LOW"],
      ["minimal", "LOW"],
      ["low", "LOW"],
      ["medium", "HIGH"],
      ["adaptive", undefined],
      ["high", "HIGH"],
      ["xhigh", "HIGH"],
    ]),
    ...budgets("gemini-pro-latest", [
      [2048, "LOW"],
      [2049, "HIGH"],
    ]),
    ...(
      [
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
      ] as const
    ).map(([modelId, thinkingLevel, expected]) => ({ modelId, thinkingLevel, expected })),
    ...(
      [
        ["gemini-3.1-flash-lite", -1, undefined],
        ["gemini-3.1-flash-lite", 0, "MINIMAL"],
        ["gemini-3.1-flash-lite", 2048, "LOW"],
        ["gemini-3.1-flash-lite", 8192, "MEDIUM"],
        ["gemini-3.1-flash-lite", 8193, "HIGH"],
        ["gemini-3.6-flash", 0, "MINIMAL"],
        ["gemini-3.7-flash", 0, "LOW"],
        ["gemini-3.8-flash", 0, "LOW"],
      ] as const
    ).map(([modelId, thinkingBudget, expected]) => ({ modelId, thinkingBudget, expected })),
  ])("maps $modelId $thinkingLevel/$thinkingBudget to $expected", ({ expected, ...input }) => {
    expect(resolveGoogleGemini3ThinkingLevel(input)).toBe(expected);
  });
});
