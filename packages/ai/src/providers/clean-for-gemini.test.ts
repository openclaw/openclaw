// Gemini schema cleaner tests cover OpenAPI-compatible tool schema cleanup for
// Gemini-backed providers before schemas are sent upstream.
import { describe, expect, it } from "vitest";
import { cleanSchemaForGemini } from "./clean-for-gemini.js";

describe("cleanSchemaForGemini", () => {
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

  it("stringifies an integer const before type without changing the schema type", () => {
    expect(cleanSchemaForGemini({ const: 42, type: "integer" })).toStrictEqual({
      enum: ["42"],
      type: "integer",
    });
  });

  it("stringifies nested numeric enums while preserving their number type", () => {
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
    expect(score?.type).toBe("number");
    expect(score?.enum).toStrictEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns no enum key when array becomes empty after coercion", () => {
    const cleaned = cleanSchemaForGemini({
      type: "integer",
      enum: [null, undefined, {}],
    }) as { enum?: unknown };

    expect(cleaned.enum).toBeUndefined();
  });

  it("preserves the type behind a percent-encoded local schema reference", () => {
    const filter = { type: "object", properties: { limit: { type: "number" } } };
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { "Filter/value~": filter },
        properties: { filter: { $ref: "#%2F%24defs%2FFilter%7E1value%7E0" } },
      }),
    ).toStrictEqual({ type: "object", properties: { filter } });
  });

  it("preserves shared definitions across inline and reference traversal", () => {
    const node = {
      type: "object",
      properties: { next: { $ref: "#/$defs/Node" } },
    };
    expect(
      cleanSchemaForGemini({
        type: "object",
        $defs: { Node: node },
        properties: { head: node },
        required: ["head"],
      }),
    ).toStrictEqual({
      type: "object",
      properties: {
        head: {
          type: "object",
          properties: { next: { type: "object", properties: { next: {} } } },
        },
      },
      required: ["head"],
    });
  });
});
