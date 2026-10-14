import {
  readCodexPluginConfig,
  resolveCodexAppServerHomeScope,
  resolveCodexAppServerRuntimeOptions,
} from "./config.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";

export type CodexBoundedTurnIsolation = "configured-transport" | "private-stdio";

export function resolveCodexBoundedTurnIsolation(options: {
  pluginConfig?: unknown;
  requireIsolatedAuth?: boolean;
}): CodexBoundedTurnIsolation {
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const homeScope = resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer });
  const { start } = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  return start.transport === "stdio" &&
    (homeScope === "agent" || options.requireIsolatedAuth === true) &&
    !isCodexAppServerProxyLaunch(start.args)
    ? "private-stdio"
    : "configured-transport";
}
