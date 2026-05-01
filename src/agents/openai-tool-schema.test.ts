import { describe, expect, it } from "vitest";
import {
  isStrictOpenAIJsonSchemaCompatible,
  normalizeOpenAIStrictToolParameters,
  normalizeStrictOpenAIJsonSchema,
  resolveOpenAIStrictToolFlagForInventory,
} from "./openai-tool-schema.js";

describe("OpenAI strict tool schema normalization", () => {
  it("repairs top-level object schemas with missing or invalid properties", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: undefined },
      { type: "object", properties: null },
      { type: "object", properties: [] },
      { type: "object", properties: "invalid" },
    ];

    for (const schema of schemas) {
      expect(normalizeStrictOpenAIJsonSchema(schema)).toEqual({
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      });
      expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
      expect(
        resolveOpenAIStrictToolFlagForInventory([{ name: "empty", parameters: schema }], true),
      ).toBe(true);
    }
  });

  it("does not close permissive nested object schemas implicitly", () => {
    const schema = {
      type: "object",
      properties: {
        metadata: {
          type: "object",
        },
      },
      required: ["metadata"],
    };

    const normalized = normalizeStrictOpenAIJsonSchema(schema) as {
      additionalProperties?: boolean;
      properties?: { metadata?: { additionalProperties?: boolean } };
    };

    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.properties?.metadata).not.toHaveProperty("additionalProperties");
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(false);
    expect(
      resolveOpenAIStrictToolFlagForInventory([{ name: "write", parameters: schema }], true),
    ).toBe(false);
  });

  it("normalizes truly empty MCP tool schema {} for strict mode", () => {
    const schema = {};
    const normalized = normalizeStrictOpenAIJsonSchema(schema) as Record<string, unknown>;
    expect(normalized.type).toBe("object");
    expect(normalized.properties).toEqual({});
    expect(normalized.required).toEqual([]);
    expect(normalized.additionalProperties).toBe(false);
    expect(isStrictOpenAIJsonSchemaCompatible(schema)).toBe(true);
  });

  // Regression for #75467: when modelCompat declares
  // `unsupportedToolSchemaKeywords: ["not"]`, the normalizer must strip
  // top-level and nested `not` keywords from tool schemas before they
  // reach the wire. Fireworks' kimi-k2p5-turbo rejects `{"not": {}}`
  // (Zod `z.never()`) with HTTP 400, breaking tool dispatch entirely.
  it("strips unsupported schema keywords from non-strict tool parameters when modelCompat opts in", () => {
    const schema = {
      type: "object",
      properties: {
        scope: { not: {} },
      },
    };
    const normalized = normalizeOpenAIStrictToolParameters(schema, false, {
      modelCompat: { unsupportedToolSchemaKeywords: ["not"] },
    }) as { properties?: { scope?: Record<string, unknown> } };

    expect(normalized.properties?.scope).not.toHaveProperty("not");
  });

  it("strips unsupported schema keywords from strict-mode tool parameters too", () => {
    const schema = {
      type: "object",
      properties: {
        scope: { not: {} },
        keep: { type: "string" },
      },
      required: ["scope", "keep"],
    };
    const normalized = normalizeOpenAIStrictToolParameters(schema, true, {
      modelCompat: { unsupportedToolSchemaKeywords: ["not"] },
    }) as {
      properties?: { scope?: Record<string, unknown>; keep?: { type?: string } };
    };

    expect(normalized.properties?.scope).not.toHaveProperty("not");
    expect(normalized.properties?.keep?.type).toBe("string");
  });

  it("preserves the `not` keyword when modelCompat does not list it as unsupported", () => {
    const schema = {
      type: "object",
      properties: {
        scope: { not: {} },
      },
    };
    const normalized = normalizeOpenAIStrictToolParameters(schema, false, {
      modelCompat: {},
    }) as { properties?: { scope?: Record<string, unknown> } };

    expect(normalized.properties?.scope).toHaveProperty("not");
  });
});
