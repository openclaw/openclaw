import { describe, expect, it } from "vitest";
import { projectAnthropicTools } from "./anthropic-tool-projection.js";

describe("projectAnthropicTools", () => {
  const toWireName = (name: string) => name;

  it("converts draft-07 tuple items to draft 2020-12 prefixItems in projected input_schema", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "tuple_tool",
          description: "tool with tuple schema",
          parameters: {
            type: "object",
            properties: {
              coords: {
                type: "array",
                items: [{ type: "number" }, { type: "number" }],
                additionalItems: false,
              },
            },
            required: ["coords"],
          },
        },
      ],
      toWireName,
    );

    expect(projection.tools).toHaveLength(1);
    const schema = projection.tools[0].inputSchema;
    expect(schema.additionalProperties).toBe(false);
    const coords = schema.properties.coords as Record<string, unknown>;
    expect(coords.prefixItems).toEqual([{ type: "number" }, { type: "number" }]);
    expect(coords.items).toBe(false); // from additionalItems: false
    expect(coords).not.toHaveProperty("additionalItems");
  });

  it("converts deep nested tuple items through anyOf in projected input_schema", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "nested_tool",
          description: "tool with nested tuple in anyOf",
          parameters: {
            type: "object",
            properties: {
              value: {
                anyOf: [
                  { type: "array", items: [{ type: "number" }, { type: "string" }] },
                  { type: "string" },
                ],
              },
            },
          },
        },
      ],
      toWireName,
    );

    expect(projection.tools).toHaveLength(1);
    const value = projection.tools[0].inputSchema.properties.value as Record<string, unknown>;
    const options = value.anyOf as Array<Record<string, unknown>>;
    expect(options[0].prefixItems).toEqual([{ type: "number" }, { type: "string" }]);
    expect(options[0]).not.toHaveProperty("items");
  });

  it("returns identity for single-schema items (no conversion)", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "simple_array_tool",
          description: "tool with simple array",
          parameters: {
            type: "object",
            properties: {
              tags: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ],
      toWireName,
    );

    expect(projection.tools).toHaveLength(1);
    const tags = projection.tools[0].inputSchema.properties.tags as Record<string, unknown>;
    expect(tags.items).toEqual({ type: "string" });
    expect(tags).not.toHaveProperty("prefixItems");
  });

  it("preserves additionalProperties: false on top-level inputSchema", () => {
    const projection = projectAnthropicTools(
      [
        {
          name: "basic_tool",
          description: "basic tool",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
      toWireName,
    );

    expect(projection.tools).toHaveLength(1);
    expect(projection.tools[0].inputSchema.additionalProperties).toBe(false);
    expect(projection.tools[0].inputSchema.type).toBe("object");
    expect(projection.tools[0].inputSchema.properties).toEqual({
      query: { type: "string" },
    });
    expect(projection.tools[0].inputSchema.required).toEqual(["query"]);
  });
});
