import { describe, expect, it } from "vitest";
import {
  isMoonshotProvider,
  MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS,
  stripMoonshotUnsupportedKeywords,
} from "./clean-for-moonshot.js";

describe("stripMoonshotUnsupportedKeywords", () => {
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
    const cleaned = stripMoonshotUnsupportedKeywords(schema);
    expect(cleaned).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("strips unsupported keywords from top-level schema", () => {
    const schema = {
      type: "string",
      minLength: 1,
      maxLength: 100,
      pattern: "^[a-z]+$",
      format: "email",
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.type).toBe("string");
    expect(cleaned.minLength).toBeUndefined();
    expect(cleaned.maxLength).toBeUndefined();
    expect(cleaned.pattern).toBeUndefined();
    expect(cleaned.format).toBeUndefined();
  });

  it("strips unsupported keywords from nested properties", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 50 },
        age: { type: "number", minimum: 0, maximum: 150 },
        email: { type: "string", format: "email" },
      },
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    const props = cleaned.properties as Record<string, unknown>;
    expect(props.name).toEqual({ type: "string" });
    expect(props.age).toEqual({ type: "number" });
    expect(props.email).toEqual({ type: "string" });
  });

  it("strips unsupported keywords from items schema", () => {
    const schema = {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: 100 },
      minItems: 1,
      maxItems: 10,
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.items).toEqual({ type: "string" });
    expect(cleaned.minItems).toBeUndefined();
    expect(cleaned.maxItems).toBeUndefined();
  });

  it("handles tuple items array", () => {
    const schema = {
      type: "array",
      items: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0 },
      ],
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.items).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("strips unsupported keywords from anyOf variants", () => {
    const schema = {
      anyOf: [
        { type: "string", minLength: 1 },
        { type: "number", minimum: 0 },
      ],
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("strips unsupported keywords from oneOf variants", () => {
    const schema = {
      oneOf: [
        { type: "string", format: "email" },
        { type: "string", format: "uri" },
      ],
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.oneOf).toEqual([{ type: "string" }, { type: "string" }]);
  });

  it("strips unsupported keywords from allOf variants", () => {
    const schema = {
      allOf: [{ type: "string", minLength: 1 }, { maxLength: 100 }],
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned.allOf).toEqual([{ type: "string" }, {}]);
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
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned).toEqual(schema);
  });

  it("strips all keywords in MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS", () => {
    const schema: Record<string, unknown> = {
      type: "object",
    };
    for (const keyword of MOONSHOT_UNSUPPORTED_SCHEMA_KEYWORDS) {
      schema[keyword] = "test";
    }
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    expect(cleaned).toEqual({ type: "object" });
  });

  it("handles deeply nested schemas", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                bio: { type: "string", maxLength: 500 },
              },
            },
          },
        },
      },
    };
    const cleaned = stripMoonshotUnsupportedKeywords(schema) as Record<string, unknown>;
    const userProfile = (cleaned.properties as Record<string, unknown>).user as Record<
      string,
      unknown
    >;
    const profile = userProfile.properties as Record<string, unknown>;
    const profileProps = (profile.profile as Record<string, unknown>).properties as Record<
      string,
      unknown
    >;
    expect(profileProps.bio).toEqual({ type: "string" });
  });
});

describe("isMoonshotProvider", () => {
  it("returns true for moonshot provider", () => {
    expect(isMoonshotProvider("moonshot")).toBe(true);
    expect(isMoonshotProvider("Moonshot")).toBe(true);
    expect(isMoonshotProvider("MOONSHOT")).toBe(true);
  });

  it("returns false for non-moonshot providers", () => {
    expect(isMoonshotProvider("openai")).toBe(false);
    expect(isMoonshotProvider("anthropic")).toBe(false);
    expect(isMoonshotProvider("google")).toBe(false);
    expect(isMoonshotProvider("xai")).toBe(false);
  });

  it("returns true for openrouter with moonshot model", () => {
    expect(isMoonshotProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isMoonshotProvider("openrouter", "moonshot/kimi-k2")).toBe(true);
    expect(isMoonshotProvider("OpenRouter", "MOONSHOTAI/KIMI")).toBe(true);
  });

  it("returns false for openrouter with non-moonshot model", () => {
    expect(isMoonshotProvider("openrouter", "anthropic/claude-3")).toBe(false);
    expect(isMoonshotProvider("openrouter", "openai/gpt-4")).toBe(false);
  });

  it("returns true for deepinfra with moonshot model", () => {
    expect(isMoonshotProvider("deepinfra", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isMoonshotProvider("DeepInfra", "MOONSHOT/test")).toBe(true);
  });

  it("returns false for deepinfra with non-moonshot model", () => {
    expect(isMoonshotProvider("deepinfra", "meta-llama/llama-3")).toBe(false);
  });

  it("handles undefined values", () => {
    expect(isMoonshotProvider(undefined, undefined)).toBe(false);
    expect(isMoonshotProvider("moonshot", undefined)).toBe(true);
    expect(isMoonshotProvider(undefined, "moonshot/test")).toBe(false);
  });
});
