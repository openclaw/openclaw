import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import registerPersonalAssistantTools from "./index.js";

function createApi(collected: Array<{ tool: AnyAgentTool; optional: boolean }>): OpenClawPluginApi {
  return {
    id: "personal-assistant-tools",
    name: "Personal Assistant Tools",
    source: "test",
    config: {},
    pluginConfig: {},
    runtime: {} as OpenClawPluginApi["runtime"],
    logger: { info() {}, warn() {}, error() {} },
    registerTool(tool, opts) {
      if (typeof tool === "function") {
        return;
      }
      collected.push({ tool, optional: opts?.optional === true });
    },
    registerHook() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    registerContextEngine() {},
    resolvePath(input: string) {
      return input;
    },
    on() {},
  };
}

describe("personal-assistant-tools plugin", () => {
  it("registers all placeholder tools as optional", () => {
    const collected: Array<{ tool: AnyAgentTool; optional: boolean }> = [];
    registerPersonalAssistantTools(createApi(collected));

    const names = collected.map((entry) => entry.tool.name).sort();
    expect(names).toEqual([
      "brainstormer_tool",
      "code_generation_tool",
      "idea_generation_tool",
      "market_data_tool",
      "trend_finder_tool",
    ]);
    expect(collected.every((entry) => entry.optional)).toBe(true);
  });
});
