import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { describe, expect, it } from "vitest";
import registerPipelineTools from "./index.js";

function createApi(collected: Array<{ tool: AnyAgentTool; optional: boolean }>): OpenClawPluginApi {
  return {
    id: "pipeline-tools",
    name: "Pipeline Tools",
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

describe("pipeline-tools plugin", () => {
  it("registers all 13 CRUD tools as optional", () => {
    const collected: Array<{ tool: AnyAgentTool; optional: boolean }> = [];
    registerPipelineTools(createApi(collected));

    const names = collected.map((entry) => entry.tool.name).sort();
    expect(names).toEqual([
      "get_engineering_tasks",
      "get_ideas",
      "get_product_specs",
      "get_trends",
      "log_agent_run",
      "save_engineering_task",
      "save_idea",
      "save_product_spec",
      "save_trend",
      "update_idea_status",
      "update_spec_status",
      "update_task_status",
      "update_trend_status",
    ]);
    expect(collected.every((entry) => entry.optional)).toBe(true);
  });
});
