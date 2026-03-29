import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import { mergePropertySchemas, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameters", () => {
  it("strips compat-declared unsupported schema keywords without provider-specific branching", () => {
    const tool: AnyAgentTool = {
      name: "demo",
      label: "demo",
      description: "demo",
      parameters: Type.Object({
        count: Type.Integer({ minimum: 1, maximum: 5 }),
        query: Type.Optional(Type.String({ minLength: 2 })),
      }),
      execute: vi.fn(),
    };

    const normalized = normalizeToolParameters(tool, {
      modelCompat: {
        unsupportedToolSchemaKeywords: ["minimum", "maximum", "minLength"],
      },
    });

    const parameters = normalized.parameters as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    };

    expect(parameters.required).toEqual(["count"]);
    expect(parameters.properties?.count.minimum).toBeUndefined();
    expect(parameters.properties?.count.maximum).toBeUndefined();
    expect(parameters.properties?.count.type).toBe("integer");
    expect(parameters.properties?.query.minLength).toBeUndefined();
    expect(parameters.properties?.query.type).toBe("string");
  });
});

describe("mergePropertySchemas", () => {
  it("preserves Optional annotation when incoming schema has optional=true", () => {
    const existing = { type: "array", items: { type: "string" } };
    const incoming = { type: "null", optional: true };

    const result = mergePropertySchemas(existing, incoming);

    expect((result as Record<string, unknown>).optional).toBe(true);
  });

  it("preserves Optional annotation when existing schema has optional=true", () => {
    const existing = { type: "string", optional: true };
    const incoming = { type: "null" };

    const result = mergePropertySchemas(existing, incoming);

    expect((result as Record<string, unknown>).optional).toBe(true);
  });

  it("preserves Optional when both schemas have optional=true", () => {
    const existing = { type: "string", optional: true };
    const incoming = { type: "null", optional: true };

    const result = mergePropertySchemas(existing, incoming);

    expect((result as Record<string, unknown>).optional).toBe(true);
  });

  it("does not add optional when neither schema has it", () => {
    const existing = { type: "string" };
    const incoming = { type: "null" };

    const result = mergePropertySchemas(existing, incoming);

    expect((result as Record<string, unknown>).optional).toBeUndefined();
  });
});
