import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import firecrawlPlugin from "../index.js";

export function captureFirecrawlTools(config: OpenClawConfig = {}) {
  const tools = new Map<string, AnyAgentTool>();
  firecrawlPlugin.register(
    createTestPluginApi({
      config,
      registerTool(tool) {
        if (typeof tool === "function" || "contextVersion" in tool) {
          throw new Error("Expected Firecrawl tools to register as tool definitions");
        }
        tools.set(tool.name, tool);
      },
    }),
  );
  return (name: string) => {
    const tool = tools.get(name);
    if (!tool) {
      throw new Error(`Expected registered Firecrawl tool: ${name}`);
    }
    return tool;
  };
}
