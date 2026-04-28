import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginHookHandlerMap, PluginHookName } from "openclaw/plugin-sdk/plugin-runtime";
import { parseForkGuardConfig } from "./src/config.js";
import { analyzeExecToolCall } from "./src/guard.js";

type ToolScopedOn = <K extends PluginHookName>(
  hookName: K,
  handler: PluginHookHandlerMap[K],
  opts?: { priority?: number; toolNames?: string[] },
) => void;

export function registerForkGuardPlugin(api: OpenClawPluginApi): void {
  const config = parseForkGuardConfig(api.pluginConfig);
  if (!config.enabled) {
    api.logger.info("fork-guard disabled");
    return;
  }

  const on = api.on as ToolScopedOn;
  on(
    "before_tool_call",
    async (event, ctx) => {
      const result = await analyzeExecToolCall({
        event,
        ctx,
        config,
        logger: api.logger,
      });
      return result;
    },
    { toolNames: ["exec"] },
  );
}

export default definePluginEntry({
  id: "fork-guard",
  name: "Fork Guard",
  description: "Blocks git push / gh pr create when the outgoing diff contains private content.",
  register: registerForkGuardPlugin,
});
