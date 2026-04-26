import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { executeComputerTool } from "./src/computer-tool.js";
import { ComputerToolSchema } from "./src/computer-tool.schema.js";
import type { ComputerToolParams } from "./src/computer-tool.schema.js";

type ComputerPluginConfig = {
  cuaDriverPath?: string;
};

function createComputerTool(ctx: OpenClawPluginToolContext): AnyAgentTool {
  const config = (ctx.config ?? {}) as ComputerPluginConfig;
  const cuaDriverPath = config.cuaDriverPath?.trim() || "cua-driver";

  return {
    name: "computer",
    label: "Computer",
    description: [
      "Control macOS desktop apps via cua-driver.",
      "Use get_app_state to inspect a running app's UI and get element indices,",
      "then click/type/scroll/set_value using those indices.",
      "All actions target the app by pid — call list_apps or list_windows to find it.",
    ].join(" "),
    parameters: ComputerToolSchema,
    execute: async (_toolCallId, params, _signal) => {
      return executeComputerTool(params as ComputerToolParams, cuaDriverPath);
    },
  };
}

export function registerComputerPlugin(api: OpenClawPluginApi): void {
  api.registerTool((ctx: OpenClawPluginToolContext) => createComputerTool(ctx));
}
