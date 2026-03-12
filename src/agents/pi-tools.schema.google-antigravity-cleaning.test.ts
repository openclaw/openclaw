import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

const noop = () => Promise.resolve({ content: [], details: {} });

/**
 * Locks down schema-cleaning behavior for Google-routed providers.
 *
 * google-antigravity proxies Anthropic models (e.g. Claude) through Google's
 * Cloud Code Assist API.  The API validates tool schemas against Gemini's
 * JSON Schema subset, so `cleanSchemaForGemini()` must always run for
 * google-routed requests — even when the *target* model is Anthropic.
 *
 * The `isAnthropicProvider` guard was removed as dead code: no current
 * Google-routed provider name contains "anthropic", so the guard never
 * triggered. These tests document the current routing semantics; they are not
 * intended to demonstrate a fail-before/pass-after regression for that guard.
 */
describe("normalizeToolParameters – Google-routed provider cleaning", () => {
  const toolWithPatternProperties = {
    name: "test_tool",
    label: "Test Tool",
    description: "A tool with patternProperties that Gemini rejects",
    execute: noop,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Name" },
      },
      patternProperties: {
        "^x-": { type: "string" },
      },
      required: ["name"],
    },
  } as AnyAgentTool;

  const toolWithAdditionalKeywords = {
    name: "test_tool_extra",
    label: "Test Tool Extra",
    description: "A tool with multiple unsupported Gemini keywords",
    execute: noop,
    parameters: {
      type: "object",
      properties: {
        value: {
          type: "number",
          exclusiveMinimum: 0,
          exclusiveMaximum: 100,
        },
      },
      required: ["value"],
    },
  } as AnyAgentTool;

  it("cleans schemas for google-antigravity provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("cleans schemas for google-antigravity even when the target model is Anthropic", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-antigravity",
      modelId: "claude-sonnet-4-5",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("cleans schemas for regular google/gemini providers", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google",
      modelId: "gemini-3-pro",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("cleans schemas for google-gemini-cli provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-gemini-cli",
      modelId: "gemini-3-pro",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("does not clean schemas for pure anthropic provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeDefined();
  });

  it("does not clean schemas for openai provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeDefined();
  });

  it("preserves exclusiveMinimum/exclusiveMaximum for google-antigravity", () => {
    const result = normalizeToolParameters(toolWithAdditionalKeywords, {
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6",
    });
    const valueSchema = (
      (result.parameters as Record<string, unknown>).properties as Record<
        string,
        Record<string, unknown>
      >
    )?.value;
    // exclusiveMinimum / exclusiveMaximum are not in the Gemini unsupported list
    expect(valueSchema?.exclusiveMinimum).toBe(0);
    expect(valueSchema?.exclusiveMaximum).toBe(100);
  });
});
