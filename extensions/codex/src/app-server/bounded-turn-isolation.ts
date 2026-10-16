import { resolveCodexAppServerRuntimeOptions, type CodexPluginConfig } from "./config.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";

export type CodexBoundedTurnIsolation = "configured-transport" | "private-stdio";

export function resolveCodexBoundedTurnIsolation(options: {
  pluginConfig?: CodexPluginConfig;
  requireIsolatedAuth?: boolean;
}): CodexBoundedTurnIsolation {
  const { start } = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  return start.transport === "stdio" &&
    (start.homeScope === "agent" || options.requireIsolatedAuth === true) &&
    !isCodexAppServerProxyLaunch(start.args)
    ? "private-stdio"
    : "configured-transport";
}
