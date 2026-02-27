import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeBox } from "./schema-convert.js";

describe("jsonSchemaToTypeBox", () => {
  it("converts a standard JSON Schema object", () => {
    const schema = jsonSchemaToTypeBox({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number" },
      },
      required: ["query"],
    });
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
  });

  it("returns empty object schema for undefined input", () => {
    const schema = jsonSchemaToTypeBox(undefined);
    expect(schema).toBeDefined();
  });

  it("returns empty object schema for empty object", () => {
    const schema = jsonSchemaToTypeBox({});
    expect(schema).toBeDefined();
  });

  it("preserves nested properties", () => {
    const input = {
      type: "object",
      properties: {
        fields: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    };
    const schema = jsonSchemaToTypeBox(input);
    expect(schema).toBeDefined();
    // The unsafe wrapper preserves the original schema
    expect((schema as Record<string, unknown>).properties).toBeDefined();
  });
});
