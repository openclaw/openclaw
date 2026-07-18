import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";

describe("normalizeToolParameterSchema llama.cpp GBNF projection", () => {
  const canonicalCronTriggerScript = {
    type: "object",
    properties: {
      job: {
        type: "object",
        properties: {
          declarationKey: {
            type: "string",
            minLength: 1,
            maxLength: 200,
            pattern: "\\S",
          },
          trigger: {
            type: "object",
            properties: {
              script: { type: "string", minLength: 1, maxLength: 65_536 },
            },
          },
        },
      },
    },
  } as const;

  it("preserves canonical constraints for non-llama.cpp providers", () => {
    expect(
      normalizeToolParameterSchema(canonicalCronTriggerScript, { modelProvider: "openai" }),
    ).toEqual(canonicalCronTriggerScript);
  });

  it("does not guess llama.cpp cleaning from provider ids", () => {
    expect(
      normalizeToolParameterSchema(canonicalCronTriggerScript, { modelProvider: "ollama" }),
    ).toEqual(canonicalCronTriggerScript);
  });

  it("strips grammar-hostile constraints for explicit llamacpp profile", () => {
    expect(
      normalizeToolParameterSchema(canonicalCronTriggerScript, {
        modelCompat: { toolSchemaProfile: "llamacpp" },
      }),
    ).toEqual({
      type: "object",
      properties: {
        job: {
          type: "object",
          properties: {
            declarationKey: {
              type: "string",
              minLength: 1,
              maxLength: 200,
            },
            trigger: {
              type: "object",
              properties: {
                script: { type: "string", minLength: 1 },
              },
            },
          },
        },
      },
    });
  });
});
