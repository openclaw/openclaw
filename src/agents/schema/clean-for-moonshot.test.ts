import { describe, expect, it } from "vitest";
import { isMoonshotProvider, stripMoonshotUnsupportedKeywords } from "./clean-for-moonshot.js";

describe("isMoonshotProvider", () => {
  it("matches direct moonshot provider", () => {
    expect(isMoonshotProvider("moonshot")).toBe(true);
  });

  it("matches moonshot provider case-insensitively", () => {
    expect(isMoonshotProvider("Moonshot")).toBe(true);
    expect(isMoonshotProvider("MOONSHOT")).toBe(true);
  });

  it("matches openrouter with moonshot model id", () => {
    expect(isMoonshotProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isMoonshotProvider("openrouter", "moonshot/kimi-k2")).toBe(true);
  });

  it("does not match openrouter with non-moonshot model id", () => {
    expect(isMoonshotProvider("openrouter", "openai/gpt-4o")).toBe(false);
    expect(isMoonshotProvider("openrouter", "anthropic/claude-3")).toBe(false);
  });

  it("matches deepinfra with moonshot model id", () => {
    expect(isMoonshotProvider("deepinfra", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isMoonshotProvider("deepinfra", "moonshot/test")).toBe(true);
  });

  it("does not match deepinfra with non-moonshot model id", () => {
    expect(isMoonshotProvider("deepinfra", "meta-llama/llama-3")).toBe(false);
  });

  it("does not match openai provider", () => {
    expect(isMoonshotProvider("openai")).toBe(false);
  });

  it("does not match google provider", () => {
    expect(isMoonshotProvider("google")).toBe(false);
  });

  it("handles undefined provider", () => {
    expect(isMoonshotProvider(undefined)).toBe(false);
  });

  it("handles undefined model id", () => {
    expect(isMoonshotProvider("moonshot", undefined)).toBe(true);
    expect(isMoonshotProvider(undefined, "moonshot/test")).toBe(false);
  });
});

describe("stripMoonshotUnsupportedKeywords", () => {
  it("strips minLength and maxLength from string properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "A name" },
      },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as {
      properties: { name: Record<string, unknown> };
    };
    expect(result.properties.name.minLength).toBeUndefined();
    expect(result.properties.name.maxLength).toBeUndefined();
    expect(result.properties.name.type).toBe("string");
    expect(result.properties.name.description).toBe("A name");
  });

  it("strips minimum and maximum from number properties", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "number", minimum: 1, maximum: 100, description: "A count" },
      },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as {
      properties: { count: Record<string, unknown> };
    };
    expect(result.properties.count.minimum).toBeUndefined();
    expect(result.properties.count.maximum).toBeUndefined();
    expect(result.properties.count.type).toBe("number");
    expect(result.properties.count.description).toBe("A count");
  });

  it("strips pattern and format from string properties", () => {
    const schema = {
      type: "object",
      properties: {
        email: { type: "string", format: "email", pattern: "^.+@.+\\..+$" },
      },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as {
      properties: { email: Record<string, unknown> };
    };
    expect(result.properties.email.format).toBeUndefined();
    expect(result.properties.email.pattern).toBeUndefined();
    expect(result.properties.email.type).toBe("string");
  });

  it("strips minItems and maxItems from array properties", () => {
    const schema = {
      type: "object",
      properties: {
        items: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } },
      },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as {
      properties: { items: Record<string, unknown> };
    };
    expect(result.properties.items.minItems).toBeUndefined();
    expect(result.properties.items.maxItems).toBeUndefined();
    expect(result.properties.items.type).toBe("array");
  });

  it("strips unsupported keywords from nested properties", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            age: { type: "number", minimum: 0 },
          },
        },
      },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as {
      properties: { user: { properties: Record<string, Record<string, unknown>> } };
    };
    expect(result.properties.user.properties.name.minLength).toBeUndefined();
    expect(result.properties.user.properties.age.minimum).toBeUndefined();
  });

  it("strips unsupported keywords from array items", () => {
    const schema = {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as { items: Record<string, unknown> };
    expect(result.items.minLength).toBeUndefined();
    expect(result.items.maxLength).toBeUndefined();
    expect(result.items.type).toBe("string");
  });

  it("handles tuple items array", () => {
    const schema = {
      type: "array",
      items: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0 },
      ],
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as { items: Record<string, unknown>[] };
    expect(result.items[0]?.minLength).toBeUndefined();
    expect(result.items[1]?.minimum).toBeUndefined();
  });

  it("strips unsupported keywords from anyOf variants", () => {
    const schema = {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0 },
      ],
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as { anyOf: Record<string, unknown>[] };
    expect(result.anyOf[0]?.minLength).toBeUndefined();
    expect(result.anyOf[1]?.minimum).toBeUndefined();
  });

  it("strips unsupported keywords from oneOf variants", () => {
    const schema = {
      oneOf: [
        { type: "string", format: "email" },
        { type: "string", format: "uri" },
      ],
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as { oneOf: Record<string, unknown>[] };
    expect(result.oneOf[0]?.format).toBeUndefined();
    expect(result.oneOf[1]?.format).toBeUndefined();
  });

  it("strips unsupported keywords from allOf variants", () => {
    const schema = {
      allOf: [{ type: "string", minLength: 1 }, { maxLength: 100 }],
    };
    const result = stripMoonshotUnsupportedKeywords(schema) as { allOf: Record<string, unknown>[] };
    expect(result.allOf[0]?.minLength).toBeUndefined();
    expect(result.allOf[1]?.maxLength).toBeUndefined();
  });

  it("preserves supported keywords", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", description: "User name" },
        count: { type: "integer", default: 0 },
      },
      required: ["name"],
      additionalProperties: true,
    };
    const result = stripMoonshotUnsupportedKeywords(schema);
    expect(result).toEqual(schema);
  });

  it("returns primitive values unchanged", () => {
    expect(stripMoonshotUnsupportedKeywords(null)).toBe(null);
    expect(stripMoonshotUnsupportedKeywords(undefined)).toBe(undefined);
    expect(stripMoonshotUnsupportedKeywords("string")).toBe("string");
    expect(stripMoonshotUnsupportedKeywords(42)).toBe(42);
    expect(stripMoonshotUnsupportedKeywords(true)).toBe(true);
  });

  it("returns arrays with recursive cleaning", () => {
    const schema = [
      { type: "string", minLength: 1 },
      { type: "number", minimum: 0 },
    ];
    const result = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>[];
    expect(result[0]?.minLength).toBeUndefined();
    expect(result[1]?.minimum).toBeUndefined();
  });
});
