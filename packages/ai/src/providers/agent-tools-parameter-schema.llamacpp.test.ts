import { describe, expect, it } from "vitest";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { LLAMACPP_TOOL_SCHEMA_PROFILE } from "./clean-for-llamacpp-gbnf.js";

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

  it("strips grammar-hostile constraints for llamacpp profile projection", () => {
    expect(
      normalizeToolParameterSchema(canonicalCronTriggerScript, {
        modelCompat: { toolSchemaProfile: LLAMACPP_TOOL_SCHEMA_PROFILE },
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

  it("strips grammar-hostile constraints for ollama provider ids", () => {
    const normalized = normalizeToolParameterSchema(canonicalCronTriggerScript, {
      modelProvider: "ollama",
    }) as {
      properties?: {
        job?: {
          properties?: {
            declarationKey?: Record<string, unknown>;
            trigger?: { properties?: { script?: Record<string, unknown> } };
          };
        };
      };
    };

    expect(normalized.properties?.job?.properties?.declarationKey).not.toHaveProperty("pattern");
    expect(normalized.properties?.job?.properties?.trigger?.properties?.script).not.toHaveProperty(
      "maxLength",
    );
  });
});
