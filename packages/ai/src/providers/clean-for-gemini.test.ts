// Gemini schema cleaner tests cover OpenAPI-compatible tool schema cleanup for
// Gemini-backed providers before schemas are sent upstream.
import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
  it("coerces null properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: null,
    }) as { type?: unknown; properties?: unknown };

    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces non-object properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: "invalid",
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("coerces array properties to an empty object", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: [],
    }) as { properties?: unknown };

    expect(cleaned.properties).toStrictEqual({});
  });

  it("filters required fields that are not in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount", "token"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("preserves required when all fields exist in properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
        amount: { type: "number" },
      },
      required: ["action", "amount"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["action", "amount"]);
  });

  it("removes required entirely when no fields match properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        action: { type: "string" },
      },
      required: ["missing_a", "missing_b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("removes required from object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toBeUndefined();
  });

  it("leaves required as-is for non-object schemas when properties is absent", () => {
    const cleaned = cleanSchemaForGemini({
      type: "array",
      required: ["a", "b"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["a", "b"]);
  });

  it("filters required in nested object properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
          required: ["name", "ghost"],
        },
      },
    }) as { properties?: { config?: { required?: string[] } } };

    expect(cleaned.properties?.config?.required).toEqual(["name"]);
  });

  it("does not treat inherited keys as declared properties", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        name: { type: "string" },
      },
      required: ["toString", "name"],
    }) as { required?: string[] };

    expect(cleaned.required).toEqual(["name"]);
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

    expect(cleaned.properties?.bad?.properties).toStrictEqual({});
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

  it("strips the not keyword from schemas", () => {
    // `not` is outside the OpenAPI 3.0 subset accepted by Gemini-backed
    // providers and triggers upstream HTTP 400s if left in tool schemas.
    const cleaned = cleanSchemaForGemini({
      type: "object",
      not: { const: true },
      properties: {
        name: { type: "string" },
      },
    }) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty("not");
    expect(cleaned.type).toBe("object");
    expect(cleaned.properties).toEqual({ name: { type: "string" } });
  });

  it("collapses type arrays by stripping null entries", () => {
    // Type arrays like ["string", "null"] must collapse to a scalar OpenAPI
    // type for Gemini compatibility.
    const cleaned = cleanSchemaForGemini({
      type: ["string", "null"],
      description: "nullable field",
    }) as Record<string, unknown>;

    expect(cleaned.type).toBe("string");
    expect(cleaned.description).toBe("nullable field");
  });

  it("collapses type arrays in nested property schemas", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        agentId: {
          type: ["string", "null"],
          description: "Agent id",
        },
      },
    }) as { properties?: { agentId?: Record<string, unknown> } };

    expect(cleaned.properties?.agentId?.type).toBe("string");
  });

  // Gemini Function Calling requires string enum values. Numeric/boolean enums
  // (common in tool schemas — priorities, scores, flags) must be coerced to
  // strings and the schema retyped as `"string"`, otherwise Gemini rejects the
  // request with `TYPE_STRING expected` errors.
  it("coerces numeric enum values to strings and retypes as string", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [1, 2, 3],
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["1", "2", "3"]);
  });

  it("coerces boolean enum values to strings", () => {
    const cleaned = cleanSchemaForGemini({
      type: "boolean",
      enum: [true, false],
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["true", "false"]);
  });

  it("preserves already-string enum values without retyping", () => {
    const cleaned = cleanSchemaForGemini({
      type: "string",
      enum: ["a", "b", "c"],
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["a", "b", "c"]);
  });

  it("coerces a numeric const to a string enum and retypes as string", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      const: 42,
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["42"]);
  });

  it("drops null/undefined enum entries and de-duplicates", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [1, 2, 2, null, undefined, 3],
    }) as { enum?: unknown };

    expect(cleaned.enum).toStrictEqual(["1", "2", "3"]);
  });

  it("coerces numeric enums inside deeply nested tool parameters", () => {
    const cleaned = cleanSchemaForGemini({
      type: "object",
      properties: {
        outer: {
          type: "array",
          items: {
            type: "object",
            properties: {
              score: { type: "number", enum: [1, 2, 3, 4, 5] },
            },
          },
        },
      },
    }) as {
      properties?: {
        outer?: { items?: { properties?: { score?: { type?: unknown; enum?: unknown } } } };
      };
    };

    const score = cleaned.properties?.outer?.items?.properties?.score;
    expect(score?.type).toBe("string");
    expect(score?.enum).toStrictEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns no enum key when array becomes empty after coercion", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [null, undefined, {}],
    }) as { enum?: unknown };

    expect(cleaned.enum).toBeUndefined();
  });

  // Regression: schema key order is not semantic. `{ enum: [...], type: "..." }`
  // must produce the same output as `{ type: "...", enum: [...] }`. If the
  // coercion is applied only while visiting `enum`, a later `type` key would
  // overwrite `type: "string"` and Gemini would still reject the declaration.
  it("coerces numeric enum with enum-before-type ordering (regression: property order independence)", () => {
    const cleaned = cleanSchemaForGemini({
      enum: [1, 2, 3],
      type: "integer",
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["1", "2", "3"]);
  });

  it("coerces boolean enum with enum-before-type ordering", () => {
    const cleaned = cleanSchemaForGemini({
      enum: [true, false],
      type: "boolean",
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["true", "false"]);
  });

  it("coerces numeric const with const-before-type ordering", () => {
    const cleaned = cleanSchemaForGemini({
      const: 42,
      type: "integer",
    }) as { type?: unknown; enum?: unknown };

    expect(cleaned.type).toBe("string");
    expect(cleaned.enum).toStrictEqual(["42"]);
  });

  it("leaves type untouched when no enum coercion happened", () => {
    // A pure integer schema without enum/const must NOT be retyped as string.
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      description: "a plain integer field",
    }) as { type?: unknown };

    expect(cleaned.type).toBe("integer");
  });
});
