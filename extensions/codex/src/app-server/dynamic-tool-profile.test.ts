import { describe, it, expect } from "vitest";
import {
  filterCodexDynamicTools,
  excludeUnsupportedDynamicToolsForModel,
} from "./dynamic-tool-profile.js";

describe("excludeUnsupportedDynamicToolsForModel", () => {
  const makeTool = (name: string) => ({ name, description: `Tool ${name}` });

  it("excludes tool_search for gpt-5.4-nano", () => {
    const tools = [
      makeTool("read"),
      makeTool("tool_search"),
      makeTool("tool_search_code"),
      makeTool("exec"),
    ];
    const result = excludeUnsupportedDynamicToolsForModel(tools, {
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
    const names = result.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).toContain("exec");
    expect(names).not.toContain("tool_search");
    expect(names).not.toContain("tool_search_code");
  });

  it("excludes tool_search for gpt-5-nano", () => {
    const tools = [makeTool("tool_search"), makeTool("read")];
    const result = excludeUnsupportedDynamicToolsForModel(tools, {
      provider: "openai",
      modelId: "gpt-5-nano",
    });
    expect(result.map((t) => t.name)).not.toContain("tool_search");
  });

  it("keeps tool_search for gpt-5.4-mini", () => {
    const tools = [makeTool("tool_search"), makeTool("read")];
    const result = excludeUnsupportedDynamicToolsForModel(tools, {
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });
    expect(result.map((t) => t.name)).toContain("tool_search");
  });

  it("keeps tool_search for gpt-4o", () => {
    const tools = [makeTool("tool_search"), makeTool("read")];
    const result = excludeUnsupportedDynamicToolsForModel(tools, {
      provider: "openai",
      modelId: "gpt-4o",
    });
    expect(result.map((t) => t.name)).toContain("tool_search");
  });

  it("keeps all tools for non-OpenAI providers", () => {
    const tools = [makeTool("tool_search"), makeTool("read")];
    const result = excludeUnsupportedDynamicToolsForModel(tools, {
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
    });
    expect(result.map((t) => t.name)).toContain("tool_search");
  });

  it("handles empty tool list", () => {
    const result = excludeUnsupportedDynamicToolsForModel([], {
      provider: "openai",
      modelId: "gpt-5.4-nano",
    });
    expect(result).toEqual([]);
  });
});
