import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import {
  buildBaseOptions,
  clampMaxTokensToContext,
  clampThinkingBudgetToMaxTokens,
  estimateContextInputTokens,
} from "./simple-options.js";

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: "test-model",
    name: "Test Model",
    api: "test-api",
    provider: "test-provider",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10_000,
    maxTokens: 9_000,
    ...overrides,
  };
}

function makeContext(text: string): Context {
  return { messages: [{ role: "user", content: text, timestamp: 0 }] };
}

describe("simple stream max-token clamp", () => {
  it("leaves a request below the remaining context budget unchanged", () => {
    expect(clampMaxTokensToContext(makeModel(), makeContext("short"), 512)).toBe(512);
  });

  it("subtracts estimated input and a safety margin from oversized requests", () => {
    const model = makeModel();
    const context = makeContext("x".repeat(4_000));
    const expected = model.contextWindow - estimateContextInputTokens(context) - 1_024;

    expect(clampMaxTokensToContext(model, context, 9_000)).toBe(expected);
  });

  it("keeps a valid floor when the estimated prompt fills the context", () => {
    expect(
      clampMaxTokensToContext(
        makeModel({ contextWindow: 1_000 }),
        makeContext("x".repeat(8_000)),
        512,
      ),
    ).toBe(1);
  });

  it.each(["你好，世界", "😀🧪🚀", "const value = foo?.bar ?? 0;"])(
    "uses a UTF-8 byte upper bound for token-dense text: %s",
    (text) => {
      expect(estimateContextInputTokens(makeContext(text))).toBeGreaterThanOrEqual(
        new TextEncoder().encode(text).byteLength,
      );
    },
  );

  it.each([
    [2_048, 1_200],
    [2_000_000, 7_813],
    [4_000_000, 8_192],
  ])("uses a bounded image estimate for %i encoded characters", (size, imageTokens) => {
    const context: Context = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", data: "a".repeat(size), mimeType: "image/png" }],
          timestamp: 0,
        },
      ],
    };

    expect(estimateContextInputTokens(context)).toBe(16 + imageTokens);
  });

  it("uses the model output limit when streamSimple has no explicit maxTokens", () => {
    const model = makeModel();
    const context = makeContext("x".repeat(4_000));

    expect(buildBaseOptions(model, undefined, undefined, context).maxTokens).toBe(
      clampMaxTokensToContext(model, context, model.maxTokens),
    );
  });

  it("preserves the largest valid thinking budget after output clamping", () => {
    expect(clampThinkingBudgetToMaxTokens(1_500, 2_048)).toBe(1_499);
    expect(clampThinkingBudgetToMaxTokens(1_024, 2_048)).toBe(1_023);
  });
});
