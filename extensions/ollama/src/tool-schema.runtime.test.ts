import { describe, expect, it } from "vitest";
import { normalizeOllamaToolSchema } from "./tool-schema.runtime.js";

describe("normalizeOllamaToolSchema", () => {
  it("keeps free-form object schemas without injecting empty properties", () => {
    const normalized = normalizeOllamaToolSchema(
      { type: "object", additionalProperties: true },
      true,
    );

    expect(normalized).toEqual({ type: "object", additionalProperties: true });
  });

  it("retains the root object fallback when no properties are declared", () => {
    const normalized = normalizeOllamaToolSchema({ type: "object" }, true);

    expect(normalized).toEqual({ type: "object", properties: {} });
  });

  it("preserves implicitly open nested objects", () => {
    const normalized = normalizeOllamaToolSchema(
      {
        type: "object",
        properties: { args: { type: "object" } },
      },
      true,
    );

    expect(normalized.properties).toEqual({ args: { type: "object" } });
  });

  it("still adds empty properties when additionalProperties is explicitly false", () => {
    const normalized = normalizeOllamaToolSchema(
      { type: "object", additionalProperties: false },
      true,
    );

    expect(normalized).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });

  it("normalizes declared properties recursively", () => {
    const normalized = normalizeOllamaToolSchema({
      type: "object",
      properties: {
        query: { anyOf: [{ type: "string" }, { type: "null" }] },
        tags: { items: { type: "string" } },
      },
      required: ["query"],
    });

    const properties = normalized.properties as Record<string, { type?: string } | undefined>;
    expect(normalized.type).toBe("object");
    expect(properties.query?.type).toBe("string");
    expect(properties.tags?.type).toBe("array");
  });

  it("keeps patternProperties-based free-form schemas without injecting empty properties", () => {
    // TypeBox's Type.Record(Type.String(), Type.Unknown()) emits patternProperties,
    // not additionalProperties, e.g. the real Tool Search "Tool Call" meta-tool's
    // nested `args` property (src/agents/tool-search.ts).
    const normalized = normalizeOllamaToolSchema({
      type: "object",
      patternProperties: { "^.*$": {} },
      description: "Tool input.",
    });

    expect(normalized).toEqual({
      type: "object",
      patternProperties: { "^.*$": {} },
      description: "Tool input.",
    });
  });

  it("keeps a nested patternProperties args property free-form inside the real Tool Call schema", () => {
    // Mirrors the exact shape src/agents/tool-search.ts's TOOL_CALL_RAW_TOOL_NAME
    // sends: a root object with a required `id` and an optional free-form `args`.
    const normalized = normalizeOllamaToolSchema(
      {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Tool search result id or tool name." },
          args: {
            type: "object",
            patternProperties: { "^.*$": {} },
            description: "Tool input.",
          },
        },
      },
      true,
    );

    const properties = normalized.properties as Record<string, Record<string, unknown> | undefined>;
    expect(properties.args).toStrictEqual({
      type: "object",
      patternProperties: { "^.*$": {} },
      description: "Tool input.",
    });
  });
});
