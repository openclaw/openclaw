import type { Context, Model } from "@openclaw/llm-core";
import type { ResponseCreateParamsStreaming } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { applyCommonResponsesParams } from "../providers/openai-responses-shared.js";
import { makeProviderModel } from "../providers/provider-model.test-support.js";
import { buildOpenAIResponsesParams } from "./openai-responses-params-internal.js";

const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } satisfies Context;
const model = makeProviderModel("openai-responses", "custom", "custom-model", {
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
  reasoning: false,
  maxTokens: 128,
});

function responsesModel(overrides: Partial<Model>): Model {
  return { ...model, ...overrides };
}

describe("Responses output capacity", () => {
  it.each([
    { requested: 256, capacity: 128, expected: 128 },
    { requested: 64, capacity: 128, expected: 64 },
    { requested: 1, capacity: 128, expected: 16 },
    { requested: 360, capacity: undefined, expected: 360 },
  ])(
    "bounds $requested tokens by capacity $capacity in both request owners",
    ({ requested, capacity, expected }) => {
      const selected = responsesModel({ maxTokens: capacity });
      expect(
        buildOpenAIResponsesParams(selected, context, { maxTokens: requested }).max_output_tokens,
      ).toBe(expected);
      const simple = {} as ResponseCreateParamsStreaming;
      applyCommonResponsesParams(simple, selected, context, { maxTokens: requested });
      expect(simple.max_output_tokens).toBe(expected);
    },
  );

  it.each([undefined, 0])("retains the managed default for an unset limit (%s)", (maxTokens) => {
    expect(buildOpenAIResponsesParams(model, context, { maxTokens }).max_output_tokens).toBe(128);
  });
});
