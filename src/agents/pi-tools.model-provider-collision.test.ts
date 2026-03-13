import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { __testing } from "./pi-tools.js";

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
      modelProvider: "openrouter",
      modelId: "x-ai/grok-4.1-fast",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("removes web_search for direct xAI providers", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelProvider: "x-ai",
      modelId: "grok-4.1",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });
});
