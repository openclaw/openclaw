import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./tools/common.js";

/**
 * Moonshot/Kimi models reject JSON Schema validation keywords (minLength,
 * maxLength, minimum, maximum, minItems, maxItems) in tool definitions.
 * These tests verify that the schema cleaning pipeline strips them when
 * the provider is Moonshot — matching the behaviour already in place for xAI.
 */
describe("normalizeToolParameters — Moonshot provider", () => {
  const toolWithConstraints = {
    name: "web_search",
    label: "Web Search",
    description: "Search the web",
    execute: async () => ({ content: [], details: {} }),
    parameters: {
      type: "object" as const,
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500 },
        count: { type: "number", minimum: 1, maximum: 10 },
        tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
      },
      required: ["query"],
    },
  } as AnyAgentTool;

  it("strips validation keywords for direct moonshot provider", () => {
    const result = normalizeToolParameters(toolWithConstraints, {
      modelProvider: "moonshot",
      modelId: "moonshot-v1-128k",
    });
    const props = (result.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    // string constraints stripped
    expect(props.query).not.toHaveProperty("minLength");
    expect(props.query).not.toHaveProperty("maxLength");
    expect(props.query).toHaveProperty("type", "string");
    // number constraints stripped
    expect(props.count).not.toHaveProperty("minimum");
    expect(props.count).not.toHaveProperty("maximum");
    // array constraints stripped
    expect(props.tags).not.toHaveProperty("minItems");
    expect(props.tags).not.toHaveProperty("maxItems");
  });

  it("strips validation keywords for openrouter with moonshotai/ model", () => {
    const result = normalizeToolParameters(toolWithConstraints, {
      modelProvider: "openrouter",
      modelId: "moonshotai/Kimi-K2.5",
    });
    const props = (result.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.query).not.toHaveProperty("minLength");
    expect(props.count).not.toHaveProperty("minimum");
    expect(props.tags).not.toHaveProperty("minItems");
  });

  it("strips validation keywords for together with kimi model", () => {
    const result = normalizeToolParameters(toolWithConstraints, {
      modelProvider: "together",
      modelId: "moonshotai/Kimi-K2-Instruct-0905",
    });
    const props = (result.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.query).not.toHaveProperty("maxLength");
    expect(props.count).not.toHaveProperty("maximum");
    expect(props.tags).not.toHaveProperty("maxItems");
  });

  it("preserves validation keywords for non-moonshot providers", () => {
    const result = normalizeToolParameters(toolWithConstraints, {
      modelProvider: "openai",
      modelId: "gpt-4o",
    });
    const props = (result.parameters as Record<string, unknown>).properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(props.query).toHaveProperty("minLength", 1);
    expect(props.query).toHaveProperty("maxLength", 500);
    expect(props.count).toHaveProperty("minimum", 1);
    expect(props.count).toHaveProperty("maximum", 10);
    expect(props.tags).toHaveProperty("minItems", 1);
    expect(props.tags).toHaveProperty("maxItems", 5);
  });

  it("preserves non-constraint schema properties", () => {
    const result = normalizeToolParameters(toolWithConstraints, {
      modelProvider: "moonshot",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params).toHaveProperty("type", "object");
    expect(params).toHaveProperty("required");
    const props = params.properties as Record<string, Record<string, unknown>>;
    expect(props.query).toHaveProperty("type", "string");
    expect(props.count).toHaveProperty("type", "number");
    expect(props.tags).toHaveProperty("type", "array");
    expect(props.tags).toHaveProperty("items");
  });
});
