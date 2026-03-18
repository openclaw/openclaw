import { describe, expect, it } from "vitest";
import {
  HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
  XAI_TOOL_SCHEMA_PROFILE,
} from "./model-compat.js";
import { __testing } from "./pi-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

const baseTools = [
  { name: "read" },
  { name: "web_search" },
  { name: "exec" },
] as unknown as AnyAgentTool[];

function toolNames(tools: AnyAgentTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("applyModelProviderToolPolicy", () => {
  it("keeps web_search for non-xAI models", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelProvider: "openai",
      modelId: "gpt-4o-mini",
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes web_search for OpenRouter xAI model ids", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("removes web_search for direct xai-capable models too", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });
});
