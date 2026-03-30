import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./api.js";
import { normalizeAimlapiToolParameters } from "./tool-payload.js";

describe("normalizeAimlapiToolParameters", () => {
  it("normalizes function-wrapped OpenAI tool parameters", () => {
    const tool = {
      type: "function",
      function: {
        name: "lookup_weather",
        parameters: {
          type: "object",
          properties: {
            city: {
              type: "string",
              minLength: 1,
            },
          },
          required: ["city"],
          additionalProperties: false,
        },
      },
    } as unknown as AnyAgentTool;

    const normalized = normalizeAimlapiToolParameters(tool) as {
      function?: { parameters?: unknown };
    };

    expect(normalized.function?.parameters).toEqual({
      type: "object",
      properties: {
        city: {
          type: "string",
        },
      },
      required: ["city"],
    });
  });
});
