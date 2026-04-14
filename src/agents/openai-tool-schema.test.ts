import { describe, expect, it } from "vitest";
import { normalizeOpenAIStrictToolParameters } from "./openai-tool-schema.js";

describe("normalizeOpenAIStrictToolParameters", () => {
  it("adds an explicit empty required array for non-strict top-level object schemas", () => {
    expect(
      normalizeOpenAIStrictToolParameters(
        {
          type: "object",
          properties: {
            text: { type: "string" },
          },
        },
        false,
      ),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: [],
    });
  });

  it("preserves explicit required fields for non-strict object schemas", () => {
    expect(
      normalizeOpenAIStrictToolParameters(
        {
          type: "object",
          properties: {
            text: { type: "string" },
          },
          required: ["text"],
        },
        false,
      ),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
      },
      required: ["text"],
    });
  });

  it("adds explicit empty required arrays recursively for nested non-strict object schemas", () => {
    expect(
      normalizeOpenAIStrictToolParameters(
        {
          type: "object",
          properties: {
            filters: {
              type: "object",
              properties: {
                status: { type: "string" },
              },
            },
          },
        },
        false,
      ),
    ).toEqual({
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
          required: [],
        },
      },
      required: [],
    });
  });

  it("does not mutate literal object values under non-schema keywords", () => {
    const literalObject = { type: "object", label: "literal" };

    expect(
      normalizeOpenAIStrictToolParameters(
        {
          type: "object",
          properties: {
            enumValue: {
              enum: [literalObject],
            },
            constValue: {
              const: literalObject,
            },
            defaultValue: {
              default: literalObject,
            },
            examplesValue: {
              examples: [literalObject],
            },
          },
        },
        false,
      ),
    ).toEqual({
      type: "object",
      properties: {
        enumValue: {
          enum: [literalObject],
        },
        constValue: {
          const: literalObject,
        },
        defaultValue: {
          default: literalObject,
        },
        examplesValue: {
          examples: [literalObject],
        },
      },
      required: [],
    });
  });
});
