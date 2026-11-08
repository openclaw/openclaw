import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { makeProviderModel } from "./provider-model.test-support.js";
import { buildBaseOptions, clampMaxTokensToModel } from "./simple-options.js";

function makeModel(overrides: Partial<Model> = {}): Model {
  return makeProviderModel("test-api", "test-provider", "test-model", {
    name: "Test Model",
    baseUrl: "https://example.test",
    reasoning: false,
    contextWindow: 10_000,
    maxTokens: 9_000,
    ...overrides,
  });
}

describe("simple stream max-token clamp", () => {
  it("preserves an explicit request when the model output limit is unknown", () => {
    expect(clampMaxTokensToModel(makeModel({ maxTokens: undefined }), 360)).toBe(360);
  });

  it.each([undefined])("preserves an omitted output limit with model limit %s", (maxTokens) => {
    expect(clampMaxTokensToModel(makeModel({ maxTokens }), undefined)).toBeUndefined();
    expect(buildBaseOptions(makeModel({ maxTokens })).maxTokens).toBeUndefined();
  });

  it("preserves constrained-output requests", () => {
    const responseFormat = {
      type: "json_schema",
      json_schema: { name: "result", strict: true, schema: { type: "object" } },
    };
    expect(buildBaseOptions(makeModel(), { responseFormat })).toMatchObject({ responseFormat });
  });
});
