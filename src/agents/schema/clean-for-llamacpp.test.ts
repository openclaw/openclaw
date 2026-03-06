import { describe, expect, it } from "vitest";
import { isLlamaCppProvider, stripLlamaCppUnsupportedKeywords } from "./clean-for-llamacpp.js";

describe("isLlamaCppProvider", () => {
  it("matches llamacpp provider name", () => {
    expect(isLlamaCppProvider("llamacpp")).toBe(true);
  });

  it("matches llama-cpp provider name", () => {
    expect(isLlamaCppProvider("llama-cpp")).toBe(true);
  });

  it("matches llama.cpp provider name", () => {
    expect(isLlamaCppProvider("llama.cpp")).toBe(true);
  });

  it("matches lmstudio provider name", () => {
    expect(isLlamaCppProvider("lmstudio")).toBe(true);
  });

  it("matches lm-studio provider name", () => {
    expect(isLlamaCppProvider("lm-studio")).toBe(true);
  });

  it("matches by localhost baseUrl on port 8080", () => {
    expect(isLlamaCppProvider(undefined, "http://localhost:8080/v1")).toBe(true);
  });

  it("matches by 127.0.0.1 baseUrl on port 8080", () => {
    expect(isLlamaCppProvider(undefined, "http://127.0.0.1:8080/v1")).toBe(true);
  });

  it("does not match localhost on non-8080 port", () => {
    expect(isLlamaCppProvider(undefined, "http://localhost:11434/v1")).toBe(false);
  });

  it("does not match remote host on port 8080", () => {
    expect(isLlamaCppProvider(undefined, "http://myserver.example.com:8080/v1")).toBe(false);
  });

  it("does not match openai provider", () => {
    expect(isLlamaCppProvider("openai")).toBe(false);
  });

  it("does not match ollama provider", () => {
    expect(isLlamaCppProvider("ollama")).toBe(false);
  });

  it("handles undefined provider and baseUrl", () => {
    expect(isLlamaCppProvider(undefined, undefined)).toBe(false);
  });
});

describe("stripLlamaCppUnsupportedKeywords", () => {
  it("strips $schema from top-level schema", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { name: { type: "string" } },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.$schema).toBeUndefined();
    expect(result.type).toBe("object");
  });

  it("strips additionalProperties from schemas", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: true,
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.additionalProperties).toBeUndefined();
    expect(result.type).toBe("object");
    expect(result.properties).toBeDefined();
  });

  it("strips $ref from schemas", () => {
    const schema = {
      type: "object",
      properties: {
        item: { $ref: "#/definitions/Item" },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      properties: { item: Record<string, unknown> };
    };
    expect(result.properties.item.$ref).toBeUndefined();
  });

  it("collapses anyOf to first non-null concrete branch", () => {
    const schema = {
      anyOf: [{ type: "string", description: "a text value" }, { type: "null" }],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.anyOf).toBeUndefined();
    expect(result.type).toBe("string");
    expect(result.description).toBe("a text value");
  });

  it("collapses oneOf to first non-null concrete branch", () => {
    const schema = {
      oneOf: [{ type: "null" }, { type: "number" }],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.oneOf).toBeUndefined();
    // first non-null is "number"
    expect(result.type).toBe("number");
  });

  it("strips keywords recursively inside nested properties", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        nested: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          additionalProperties: true,
          properties: {
            value: { type: "string" },
          },
        },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      additionalProperties?: unknown;
      properties: {
        nested: Record<string, unknown>;
      };
    };
    expect(result.additionalProperties).toBeUndefined();
    expect(result.properties.nested.$schema).toBeUndefined();
    expect(result.properties.nested.additionalProperties).toBeUndefined();
    expect(result.properties.nested.type).toBe("object");
  });

  it("strips keywords inside array item schemas", () => {
    const schema = {
      type: "array",
      items: {
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
        additionalProperties: false,
        properties: { id: { type: "string" } },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      items: Record<string, unknown>;
    };
    expect(result.items.$schema).toBeUndefined();
    expect(result.items.additionalProperties).toBeUndefined();
    expect(result.items.type).toBe("object");
  });

  it("preserves required, type, description, and other safe keywords", () => {
    const schema = {
      type: "object",
      description: "A tool schema",
      required: ["name"],
      properties: {
        name: { type: "string", description: "The name" },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.type).toBe("object");
    expect(result.description).toBe("A tool schema");
    expect(result.required).toEqual(["name"]);
    expect(result.properties as Record<string, unknown>).toBeDefined();
  });

  it("passes through primitives and null unchanged", () => {
    expect(stripLlamaCppUnsupportedKeywords(null)).toBeNull();
    expect(stripLlamaCppUnsupportedKeywords("string")).toBe("string");
    expect(stripLlamaCppUnsupportedKeywords(42)).toBe(42);
  });

  it("passes through arrays recursively", () => {
    const schemas = [
      { type: "string", $schema: "x" },
      { type: "number", additionalProperties: true },
    ];
    const result = stripLlamaCppUnsupportedKeywords(schemas) as Array<Record<string, unknown>>;
    expect(result[0].$schema).toBeUndefined();
    expect(result[0].type).toBe("string");
    expect(result[1].additionalProperties).toBeUndefined();
    expect(result[1].type).toBe("number");
  });

  it("preserves sibling keys (description, default) when collapsing anyOf", () => {
    // Greptile-flagged bug: sibling keys on the parent were silently discarded.
    const schema = {
      description: "The file path to read",
      default: "./index.ts",
      anyOf: [{ type: "string" }, { type: "null" }],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.anyOf).toBeUndefined();
    expect(result.type).toBe("string");
    expect(result.description).toBe("The file path to read");
    expect(result.default).toBe("./index.ts");
  });

  it("preserves sibling keys when collapsing oneOf", () => {
    const schema = {
      title: "Count field",
      description: "Number of items",
      oneOf: [{ type: "null" }, { type: "integer", minimum: 0 }],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.oneOf).toBeUndefined();
    expect(result.type).toBe("integer");
    expect(result.title).toBe("Count field");
    expect(result.description).toBe("Number of items");
  });

  it("concrete branch type wins over sibling type when collapsing anyOf", () => {
    // Concrete branch takes precedence for overlapping keys like `type`.
    const schema = {
      type: "object", // sibling — should be overwritten by the concrete branch type
      anyOf: [{ type: "string" }, { type: "null" }],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(result.type).toBe("string");
  });

  it("strips unsupported keywords inside $defs recursively", () => {
    // Codex-flagged bug: only properties/items were recursed; $defs was copied verbatim.
    const schema = {
      type: "object",
      $defs: {
        Item: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          additionalProperties: false,
          properties: { id: { type: "string" } },
        },
      },
      properties: {
        item: { $ref: "#/$defs/Item" },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      $defs: { Item: Record<string, unknown> };
    };
    expect(result.$defs.Item.$schema).toBeUndefined();
    expect(result.$defs.Item.additionalProperties).toBeUndefined();
    expect(result.$defs.Item.type).toBe("object");
  });

  it("strips unsupported keywords inside allOf recursively", () => {
    const schema = {
      allOf: [
        { $ref: "#/$defs/Base" },
        { type: "object", additionalProperties: false, properties: { name: { type: "string" } } },
      ],
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      allOf: Array<Record<string, unknown>>;
    };
    // $ref is stripped, leaving an empty object for the first branch
    expect(result.allOf[0]).toEqual({});
    expect(result.allOf[1].additionalProperties).toBeUndefined();
    expect(result.allOf[1].type).toBe("object");
  });

  it("strips unsupported keywords inside definitions recursively", () => {
    const schema = {
      type: "object",
      definitions: {
        Address: {
          type: "object",
          additionalProperties: true,
          $schema: "x",
          properties: { street: { type: "string" } },
        },
      },
    };
    const result = stripLlamaCppUnsupportedKeywords(schema) as {
      definitions: { Address: Record<string, unknown> };
    };
    expect(result.definitions.Address.$schema).toBeUndefined();
    expect(result.definitions.Address.additionalProperties).toBeUndefined();
    expect(result.definitions.Address.type).toBe("object");
  });
});
