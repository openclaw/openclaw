import { describe, expect, it } from "vitest";
import { normalizeOllamaToolSchema } from "./tool-schema.runtime.js";

describe("normalizeOllamaToolSchema", () => {
  it("retains the root object fallback when no properties are declared", () => {
    const normalized = normalizeOllamaToolSchema({ type: "object" }, true);

    expect(normalized).toEqual({ type: "object", properties: {} });
  });

  it("preserves implicitly open nested objects", () => {
    const normalized = normalizeOllamaToolSchema(
      {
        type: "object",
        properties: { args: { type: "object" } },
      },
      true,
    );

    expect(normalized.properties).toEqual({ args: { type: "object" } });
  });

  it("still adds empty properties when additionalProperties is explicitly false", () => {
    const normalized = normalizeOllamaToolSchema(
      { type: "object", additionalProperties: false },
      true,
    );

    expect(normalized).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });
});
