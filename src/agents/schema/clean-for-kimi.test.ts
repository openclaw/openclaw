import { describe, expect, it } from "vitest";
import { compactToolSchemaForKimi, isKimiSchemaCompactionTarget } from "./clean-for-kimi.js";

describe("clean-for-kimi", () => {
  it("strips verbose schema metadata and validation noise recursively", () => {
    const cleaned = compactToolSchemaForKimi({
      type: "object",
      description: "Top level",
      properties: {
        path: {
          type: "string",
          description: "Filesystem path",
          minLength: 1,
        },
        options: {
          type: "object",
          title: "Options",
          additionalProperties: true,
          properties: {
            count: {
              type: "number",
              minimum: 1,
              maximum: 5,
            },
          },
        },
      },
    }) as {
      description?: unknown;
      properties?: Record<string, unknown>;
    };

    const path = cleaned.properties?.path as
      | {
          description?: unknown;
          minLength?: unknown;
        }
      | undefined;
    const options = cleaned.properties?.options as
      | {
          title?: unknown;
          additionalProperties?: unknown;
          properties?: Record<string, unknown>;
        }
      | undefined;
    const count = options?.properties?.count as
      | {
          minimum?: unknown;
          maximum?: unknown;
        }
      | undefined;

    expect(cleaned.description).toBeUndefined();
    expect(path?.description).toBeUndefined();
    expect(path?.minLength).toBeUndefined();
    expect(options?.title).toBeUndefined();
    expect(options?.additionalProperties).toBeUndefined();
    expect(count?.minimum).toBeUndefined();
    expect(count?.maximum).toBeUndefined();
  });

  it("inlines local refs before dropping defs", () => {
    const cleaned = compactToolSchemaForKimi({
      type: "object",
      properties: {
        child: { $ref: "#/$defs/Child" },
      },
      $defs: {
        Child: {
          type: "object",
          description: "Child payload",
          properties: {
            name: {
              type: "string",
              minLength: 1,
            },
          },
        },
      },
    }) as {
      $defs?: unknown;
      properties?: Record<string, unknown>;
    };

    const child = cleaned.properties?.child as
      | {
          $ref?: unknown;
          description?: unknown;
          properties?: Record<string, unknown>;
        }
      | undefined;
    const name = child?.properties?.name as
      | {
          minLength?: unknown;
        }
      | undefined;

    expect(cleaned.$defs).toBeUndefined();
    expect(child?.$ref).toBeUndefined();
    expect(child?.description).toBeUndefined();
    expect(child?.properties?.name).toBeDefined();
    expect(name?.minLength).toBeUndefined();
  });

  it("omits heavyweight sessions_spawn parameters", () => {
    const cleaned = compactToolSchemaForKimi(
      {
        type: "object",
        required: ["task", "attachments"],
        properties: {
          task: { type: "string" },
          resumeSessionId: { type: "string", description: "resume" },
          attachments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
          attachAs: {
            type: "object",
            properties: {
              mountPath: { type: "string" },
            },
          },
        },
      },
      { toolName: "sessions_spawn" },
    ) as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(cleaned.properties?.task).toBeDefined();
    expect(cleaned.properties?.resumeSessionId).toBeUndefined();
    expect(cleaned.properties?.attachments).toBeUndefined();
    expect(cleaned.properties?.attachAs).toBeUndefined();
    expect(cleaned.required).toEqual(["task"]);
  });

  it("targets Kimi-compatible OpenAI models but not kimi-coding", () => {
    expect(isKimiSchemaCompactionTarget("nvidia-nim", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isKimiSchemaCompactionTarget("openrouter", "@preset/kimi-2-5")).toBe(true);
    expect(isKimiSchemaCompactionTarget("moonshot")).toBe(false);
    expect(isKimiSchemaCompactionTarget("moonshot", "kimi-k2.5")).toBe(true);
    expect(isKimiSchemaCompactionTarget("moonshot", "moonshot-v1-8k")).toBe(false);
    expect(isKimiSchemaCompactionTarget("kimi-code", "kimi-k2.5")).toBe(false);
    expect(isKimiSchemaCompactionTarget("kimi-coding", "kimi-k2.5")).toBe(false);
    expect(isKimiSchemaCompactionTarget("anthropic", "claude-sonnet-4-6")).toBe(false);
    expect(isKimiSchemaCompactionTarget("openai", "gpt-5")).toBe(false);
  });
});
