import { describe, expect, it } from "vitest";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("createOpenClawTools set_thinking_level", () => {
  it("omits set_thinking_level for native-adaptive Claude 4.6 models", () => {
    const tool = createOpenClawTools({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      reasoningSupported: true,
    }).find((candidate) => candidate.name === "set_thinking_level");

    expect(tool).toBeUndefined();
  });

  it("registers the set_thinking_level tool with the expected schema for non-native-adaptive models", () => {
    const tool = createOpenClawTools({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      reasoningSupported: true,
    }).find((candidate) => candidate.name === "set_thinking_level");

    expect(tool).toBeDefined();
    expect(tool?.label).toBe("Set Thinking Level");
    expect(tool?.parameters).toMatchObject({
      type: "object",
      properties: {
        level: { type: "string" },
        scope: { type: "string" },
      },
    });
  });

  it("describes when to use turn versus session scope when the tool is available", () => {
    const tool = createOpenClawTools({
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      reasoningSupported: true,
    }).find((candidate) => candidate.name === "set_thinking_level");

    expect(tool).toBeDefined();
    expect(tool?.description).toContain("current run or session default");
    expect(tool?.description).toContain("use `turn` for temporary one-off hard tasks");
    expect(tool?.description).toContain("`session` for lasting or user-requested changes");
  });
});
