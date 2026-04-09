import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { isUpdatePlanToolEnabledForOpenClawTools } from "./openclaw-tools.registration.js";
import { createUpdatePlanTool } from "./tools/update-plan-tool.js";

describe("openclaw-tools update_plan gating", () => {
  it("keeps update_plan disabled by default", () => {
    expect(isUpdatePlanToolEnabledForOpenClawTools({} as OpenClawConfig)).toBe(false);
  });

  it("registers update_plan when explicitly enabled", () => {
    const config = {
      tools: {
        experimental: {
          planTool: true,
        },
      },
    } as OpenClawConfig;

    expect(isUpdatePlanToolEnabledForOpenClawTools(config)).toBe(true);
    expect(createUpdatePlanTool().displaySummary).toBe("Track a short structured work plan.");
  });

  it("auto-enables update_plan for OpenAI-family providers", () => {
    expect(isUpdatePlanToolEnabledForOpenClawTools({} as OpenClawConfig, "openai")).toBe(true);
    expect(isUpdatePlanToolEnabledForOpenClawTools({} as OpenClawConfig, "openai-codex")).toBe(
      true,
    );
    expect(isUpdatePlanToolEnabledForOpenClawTools({} as OpenClawConfig, "anthropic")).toBe(false);
  });

  it("lets config disable update_plan auto-enable", () => {
    const config = {
      tools: {
        experimental: {
          planTool: false,
        },
      },
    } as OpenClawConfig;

    expect(isUpdatePlanToolEnabledForOpenClawTools(config, "openai")).toBe(false);
  });
});
