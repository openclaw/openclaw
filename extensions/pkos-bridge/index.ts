import { definePluginEntry, type AnyAgentTool, type OpenClawPluginApi } from "./api.js";
import { createPkosBridgeCommand } from "./src/command.js";
import {
  pkosBridgeConfigSchema,
  resolvePkosBridgeConfig,
  type ResolvedPkosBridgeConfig,
} from "./src/config.js";
import {
  createPkosBridgeStatusGatewayMethod,
  createPrepareTaskHandoffGatewayMethod,
  createSubmitTraceBundleGatewayMethod,
} from "./src/gateway.js";
import { createPkosBridgeHttpHandler } from "./src/http.js";
import { PKOS_BRIDGE_AGENT_GUIDANCE } from "./src/prompt-guidance.js";
import {
  createPkosBridgeStatusTool,
  createPrepareTaskHandoffTool,
  createSubmitTraceBundleTool,
} from "./src/tools.js";

function registerGuidance(api: OpenClawPluginApi, config: ResolvedPkosBridgeConfig): void {
  if (!config.guidance.enabled) {
    return;
  }
  api.on("before_prompt_build", async () => ({
    prependSystemContext: PKOS_BRIDGE_AGENT_GUIDANCE,
  }));
}

export default definePluginEntry({
  id: "pkos-bridge",
  name: "PKOS Bridge",
  description: "Bridge surfaces for PKOS, Workbench, and OpenClaw handoff flows.",
  configSchema: pkosBridgeConfigSchema,
  register(api: OpenClawPluginApi) {
    const config = resolvePkosBridgeConfig(api.pluginConfig);

    registerGuidance(api, config);

    api.registerTool(createPkosBridgeStatusTool(config) as AnyAgentTool, {
      name: "pkos_bridge_status",
    });
    api.registerTool(createPrepareTaskHandoffTool(config) as AnyAgentTool, {
      name: "pkos_bridge_prepare_task_handoff",
    });
    api.registerTool(createSubmitTraceBundleTool(config) as AnyAgentTool, {
      name: "pkos_bridge_submit_trace_bundle",
    });

    api.registerGatewayMethod("pkosBridge.status", createPkosBridgeStatusGatewayMethod(config));
    api.registerGatewayMethod(
      "pkosBridge.prepareTaskHandoff",
      createPrepareTaskHandoffGatewayMethod(config),
    );
    api.registerGatewayMethod(
      "pkosBridge.submitTraceBundle",
      createSubmitTraceBundleGatewayMethod(config),
    );

    api.registerCommand(createPkosBridgeCommand(config));
    api.registerHttpRoute({
      path: config.http.basePath,
      auth: "plugin",
      match: "prefix",
      handler: createPkosBridgeHttpHandler(config),
    });
  },
});
