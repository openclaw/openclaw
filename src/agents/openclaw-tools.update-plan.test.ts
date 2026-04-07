import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("openclaw-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    const tools = createOpenClawTools({
      config: {} as OpenClawConfig,
    });

    expect(tools.map((tool) => tool.name)).not.toContain("update_plan");
  });

  it("registers update_plan when explicitly enabled", () => {
    const tools = createOpenClawTools({
      config: {
        tools: {
          experimental: {
            planTool: true,
          },
        },
      } as OpenClawConfig,
    });

    const updatePlan = tools.find((tool) => tool.name === "update_plan");
    expect(updatePlan?.displaySummary).toBe("Track a short structured work plan.");
  });

  it("auto-enables update_plan for OpenAI-family providers", () => {
    const openaiTools = createOpenClawTools({
      config: {} as OpenClawConfig,
      modelProvider: "openai",
    });
    const codexTools = createOpenClawTools({
      config: {} as OpenClawConfig,
      modelProvider: "openai-codex",
    });
    const anthropicTools = createOpenClawTools({
      config: {} as OpenClawConfig,
      modelProvider: "anthropic",
    });

    expect(openaiTools.map((tool) => tool.name)).toContain("update_plan");
    expect(codexTools.map((tool) => tool.name)).toContain("update_plan");
    expect(anthropicTools.map((tool) => tool.name)).not.toContain("update_plan");
  });
});
