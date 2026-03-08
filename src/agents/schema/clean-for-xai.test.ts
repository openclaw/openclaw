import { describe, expect, it } from "vitest";
import { isMoonshotProvider, isXaiProvider, stripXaiUnsupportedKeywords } from "./clean-for-xai.js";

describe("isXaiProvider", () => {
  it("matches direct xai provider", () => {
    expect(isXaiProvider("xai")).toBe(true);
  });

  it("matches x-ai provider string", () => {
    expect(isXaiProvider("x-ai")).toBe(true);
  });

  it("matches openrouter with x-ai model id", () => {
    expect(isXaiProvider("openrouter", "x-ai/grok-4.1-fast")).toBe(true);
  });

  it("does not match openrouter with non-xai model id", () => {
    expect(isXaiProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("does not match openai provider", () => {
    expect(isXaiProvider("openai")).toBe(false);
  });

  it("does not match google provider", () => {
    expect(isXaiProvider("google")).toBe(false);
  });

  it("handles undefined provider", () => {
    expect(isXaiProvider(undefined)).toBe(false);
  });

  it("matches venice provider with grok model id", () => {
    expect(isXaiProvider("venice", "grok-4.1-fast")).toBe(true);
  });

  it("matches venice provider with venice/ prefixed grok model id", () => {
    expect(isXaiProvider("venice", "venice/grok-4.1-fast")).toBe(true);
  });

  it("does not match venice provider with non-grok model id", () => {
    expect(isXaiProvider("venice", "llama-3.3-70b")).toBe(false);
  });
});

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
    expect(result.contains).toBeDefined();
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
});

describe("isMoonshotProvider", () => {
  it("matches direct moonshot provider", () => {
    expect(isMoonshotProvider("moonshot")).toBe(true);
  });

  it("matches case-insensitively on provider id", () => {
    expect(isMoonshotProvider("Moonshot")).toBe(true);
    expect(isMoonshotProvider("MOONSHOT")).toBe(true);
  });

  it("matches openrouter with moonshotai/ model prefix", () => {
    expect(isMoonshotProvider("openrouter", "moonshotai/Kimi-K2.5")).toBe(true);
  });

  it("matches together with moonshotai/ model prefix", () => {
    expect(isMoonshotProvider("together", "moonshotai/Kimi-K2-Instruct-0905")).toBe(true);
  });

  it("matches openrouter with kimi in model id", () => {
    expect(isMoonshotProvider("openrouter", "kimi-k2.5")).toBe(true);
  });

  it("does not match openrouter with non-moonshot model", () => {
    expect(isMoonshotProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("does not match unrelated providers", () => {
    expect(isMoonshotProvider("openai")).toBe(false);
    expect(isMoonshotProvider("anthropic")).toBe(false);
    expect(isMoonshotProvider("google")).toBe(false);
  });

  it("handles undefined provider", () => {
    expect(isMoonshotProvider(undefined)).toBe(false);
  });
});
