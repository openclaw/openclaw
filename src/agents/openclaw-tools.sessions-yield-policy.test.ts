import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function toolNames(tools: ReturnType<typeof createOpenClawTools>): string[] {
  return tools.map((tool) => tool.name);
}

describe("openclaw-tools sessions_yield gating", () => {
  it("includes sessions_yield by default", () => {
    const tools = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(toolNames(tools)).toContain("sessions_yield");
  });

  it("omits sessions_yield when explicitly denied via tools.deny", () => {
    const config = { tools: { deny: ["sessions_yield"] } } as OpenClawConfig;
    const tools = createOpenClawTools({
      config,
      disablePluginTools: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(toolNames(tools)).not.toContain("sessions_yield");
  });

  it("omits sessions_yield when an allowlist is set without it", () => {
    const config = { tools: { allow: ["message"] } } as OpenClawConfig;
    const tools = createOpenClawTools({
      config,
      disablePluginTools: true,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(toolNames(tools)).not.toContain("sessions_yield");
  });

  it("omits sessions_yield when pluginToolDenylist includes it", () => {
    const tools = createOpenClawTools({
      config: {} as OpenClawConfig,
      disablePluginTools: true,
      pluginToolDenylist: ["sessions_yield"],
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    expect(toolNames(tools)).not.toContain("sessions_yield");
  });
});
