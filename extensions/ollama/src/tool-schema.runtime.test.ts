// Recursive normalization is asserted at the outgoing stream request in
// stream-runtime.test.ts. Add helper cases here only for distinct root or
// nested-object contracts.
import { describe, expect, it } from "vitest";
import { normalizeOllamaToolSchema } from "./tool-schema.runtime.js";

describe("normalizeOllamaToolSchema", () => {
  it("retains the root object fallback when no properties are declared", () => {
    const normalized = normalizeOllamaToolSchema({ type: "object" }, true);
    expect(normalized).toEqual({ type: "object", properties: {} });
  });

  it("preserves implicitly open nested objects", () => {
    const schema = { type: "object", properties: { args: { type: "object" } } };
    expect(normalizeOllamaToolSchema(schema, true).properties).toEqual({
      args: { type: "object" },
    });
  });

  it("still adds empty properties when additionalProperties is explicitly false", () => {
    expect(
      normalizeOllamaToolSchema({ type: "object", additionalProperties: false }, true),
    ).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });
});
