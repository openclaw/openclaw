import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: null,
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: "invalid",
    }) as { properties?: unknown };

    expect(cleaned.properties).toEqual({});
  });

  it("coerces array properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: [],
    }) as { properties?: unknown };

    expect(cleaned.properties).toEqual({});
  });

  it("coerces nested null properties while preserving valid siblings", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        bad: {
          type: "object",
          properties: null,
        },
        good: {
          type: "string",
        },
      },
    }) as {
      properties?: {
        bad?: { properties?: unknown };
        good?: { type?: unknown };
      };
    };

    expect(cleaned.properties?.bad?.properties).toEqual({});
    expect(cleaned.properties?.good?.type).toBe("string");
  });

  it("strips empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: [],
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("required");
    expect(cleaned.type).toBe("object");
  });

  it("preserves non-empty required arrays", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["name"],
    }) as Record<string, unknown>;

    expect(cleaned.required).toEqual(["name"]);
  });

  it("strips empty required arrays in nested schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            optional: { type: "string" },
          },
          required: [],
        },
      },
      required: ["nested"],
    }) as { properties?: { nested?: Record<string, unknown> }; required?: string[] };

    expect(cleaned.required).toEqual(["nested"]);
    expect(cleaned.properties?.nested).not.toHaveProperty("required");
  });
});
