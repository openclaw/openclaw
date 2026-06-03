import { describe, expect, it } from "vitest";
import { stripUnsupportedSchemaKeywords } from "../../plugin-sdk/provider-tools.js";

const XAI_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
]);

function stripXaiUnsupportedKeywords(schema: unknown): unknown {
  return stripUnsupportedSchemaKeywords(schema, XAI_UNSUPPORTED_SCHEMA_KEYWORDS);
}

describe("stripXaiUnsupportedKeywords", () => {
  it("strips minLength and maxLength from string properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "A name" },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { name: Record<string, unknown> };
    };
    expect(result.properties.name.minLength).toBeUndefined();
    expect(result.properties.name.maxLength).toBeUndefined();
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.name.description).toBe("A name");
  });

  it("strips minItems and maxItems from array properties", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { items: Record<string, unknown> };
    };
    expect(result.properties.items.minItems).toBeUndefined();
    expect(result.properties.items.maxItems).toBeUndefined();
    expect(result.properties.items.type).toBe("array");
  });

  it("strips minContains and maxContains", () => {
    const schema = {
      type: "array",
      minContains: 1,
      maxContains: 5,
      contains: { type: "string" },
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.minContains).toBeUndefined();
    expect(result.maxContains).toBeUndefined();
    expect(result.contains).toEqual({ type: "string" });
  });

  it("strips keywords recursively inside nested objects", () => {
    const schema = {
      type: "object",
      properties: {
        attachment: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: 6_700_000 },
          },
        },
      },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      properties: { attachment: { properties: { content: Record<string, unknown> } } };
    };
    expect(result.properties.attachment.properties.content.maxLength).toBeUndefined();
    expect(result.properties.attachment.properties.content.type).toBe("string");
  });

  it("strips keywords inside anyOf/oneOf/allOf variants", () => {
    const schema = {
      anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect(result.anyOf[0].minLength).toBeUndefined();
    expect(result.anyOf[0].type).toBe("string");
  });

  it("strips keywords inside array item schemas", () => {
    const schema = {
      type: "array",
      items: { type: "string", maxLength: 100 },
    };
    const result = stripXaiUnsupportedKeywords(schema) as {
      items: Record<string, unknown>;
    };
    expect(result.items.maxLength).toBeUndefined();
    expect(result.items.type).toBe("string");
  });

  it("preserves all other schema keywords", () => {
    const schema = {
      type: "object",
      description: "A tool schema",
      required: ["name"],
      properties: {
        name: { type: "string", description: "The name", enum: ["foo", "bar"] },
      },
      additionalProperties: false,
    };
    const result = stripXaiUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.type).toBe("object");
    expect(result.description).toBe("A tool schema");
    expect(result.required).toEqual(["name"]);
    expect(result.additionalProperties).toBe(false);
  });

  it("passes through primitives and null unchanged", () => {
    expect(stripXaiUnsupportedKeywords(null)).toBeNull();
    expect(stripXaiUnsupportedKeywords("string")).toBe("string");
    expect(stripXaiUnsupportedKeywords(42)).toBe(42);
  });

  it("does not trust source array traversal methods", () => {
    const anyOf = [{ type: "string", maxLength: 10 }, { type: "null" }];
    Object.defineProperty(anyOf, "map", {
      value() {
        throw new Error("fuzzplugin schema array map exploded");
      },
    });
    const result = stripXaiUnsupportedKeywords({ anyOf }) as {
      anyOf: Array<Record<string, unknown>>;
    };

    expect(result.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });

  it("snapshots schema array length before reading entries", () => {
    let lengthReads = 0;
    const anyOf = new Proxy([{ type: "string", maxLength: 10 }, { type: "null" }], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          if (lengthReads > 1) {
            throw new Error("fuzzplugin schema array length exploded");
          }
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const result = stripXaiUnsupportedKeywords({ anyOf }) as {
      anyOf: Array<Record<string, unknown>>;
    };

    expect(result.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
  });

  it("preserves readable properties when a sibling schema is unreadable", () => {
    const unreadableChild = new Proxy(
      { type: "string", maxLength: 10 },
      {
        ownKeys() {
          throw new Error("fuzzplugin child schema ownKeys exploded");
        },
      },
    );
    const result = stripXaiUnsupportedKeywords({
      type: "object",
      properties: {
        healthy: { type: "string", maxLength: 10 },
        broken: unreadableChild,
      },
    }) as { properties: Record<string, unknown> };

    expect(result.properties).toEqual({
      healthy: { type: "string" },
      broken: {},
    });
  });

  it("preserves readable object fields when a sibling getter throws", () => {
    const schema = {
      type: "object",
      maxLength: 10,
      description: "A schema",
    };
    Object.defineProperty(schema, "broken", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin schema field getter exploded");
      },
    });

    expect(stripXaiUnsupportedKeywords(schema)).toEqual({
      type: "object",
      description: "A schema",
    });
  });

  it("omits unreadable scalar fields instead of replacing them with schemas", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
      },
    };
    Object.defineProperty(schema, "required", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin required getter exploded");
      },
    });

    expect(stripXaiUnsupportedKeywords(schema)).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
      },
    });
  });

  it("omits unreadable schema maps without throwing", () => {
    const properties = new Proxy(
      {
        healthy: { type: "string", maxLength: 10 },
      },
      {
        ownKeys() {
          throw new Error("fuzzplugin properties ownKeys exploded");
        },
      },
    );
    const result = stripXaiUnsupportedKeywords({
      type: "object",
      properties,
    }) as { properties: Record<string, unknown> };

    expect(result.properties).toEqual({});
  });
});
