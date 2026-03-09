import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";

/**
 * Tests for google-antigravity schema cleaning behavior.
 *
 * google-antigravity proxies Anthropic models (e.g. Claude) through Google's
 * Cloud Code Assist API.  The API validates tool schemas against Gemini's
 * JSON Schema subset, so `cleanSchemaForGemini()` must always run for
 * google-routed requests — even when the *target* model is Anthropic.
 *
 * The `isAnthropicProvider` guard was removed as dead code: no current
 * Google-routed provider name contains "anthropic", so the guard never
 * triggered. Removing it simplifies the logic and future-proofs against
 * hypothetical provider names that might match both "google" and "anthropic".
 */
describe("normalizeToolParameters – google-antigravity schema cleaning", () => {
  const toolWithPatternProperties = {
    name: "test_tool",
    description: "A tool with patternProperties that Gemini rejects",
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
  };

  const toolWithAdditionalKeywords = {
    name: "test_tool_extra",
    description: "A tool with multiple unsupported Gemini keywords",
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
  };

  it("should clean schemas for google-antigravity provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("should clean schemas for google-antigravity even with Anthropic model IDs", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-antigravity",
      modelId: "claude-sonnet-4-5",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("should clean schemas for regular google/gemini providers", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google",
      modelId: "gemini-3-pro",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("should clean schemas for google-gemini-cli provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "google-gemini-cli",
      modelId: "gemini-3-pro",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeUndefined();
  });

  it("should NOT clean schemas for pure anthropic provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "anthropic",
      modelId: "claude-opus-4-6",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeDefined();
  });

  it("should NOT clean schemas for openai provider", () => {
    const result = normalizeToolParameters(toolWithPatternProperties, {
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    const params = result.parameters as Record<string, unknown>;
    expect(params.patternProperties).toBeDefined();
  });

  it("should strip unsupported Gemini keywords for google-antigravity", () => {
    const result = normalizeToolParameters(toolWithAdditionalKeywords, {
      modelProvider: "google-antigravity",
      modelId: "claude-opus-4-6",
    });
    const valueSchema = (
      (result.parameters as Record<string, unknown>).properties as Record<string, Record<string, unknown>>
    )?.value;
    // Gemini does not support exclusiveMinimum / exclusiveMaximum
    expect(valueSchema?.exclusiveMinimum).toBeUndefined();
    expect(valueSchema?.exclusiveMaximum).toBeUndefined();
  });
});
