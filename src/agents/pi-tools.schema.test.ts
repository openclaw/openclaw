import { describe, expect, it } from "vitest";
import { normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

describe("normalizeToolParameters", () => {
  it("adds an empty properties object when schema is object-typed without properties", () => {
    const tool = {
      name: "read",
      description: "Read file",
      parameters: { type: "object" },
    } as unknown as AnyAgentTool;

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "openai-completions",
      modelId: "routellm/model",
    });

    expect((normalized.parameters as { type?: string; properties?: unknown })?.properties).toEqual(
      {},
    );
    expect((normalized.parameters as { type?: string })?.type).toBe("object");
  });

  it("leaves existing properties untouched when already present", () => {
    const tool = {
      name: "read",
      description: "Read file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    } as unknown as AnyAgentTool;

    const normalized = normalizeToolParameters(tool, {
      modelProvider: "openai-completions",
      modelId: "routellm/model",
    });

    expect((normalized.parameters as { properties?: unknown })?.properties).toEqual({
      path: { type: "string" },
    });
  });
});
