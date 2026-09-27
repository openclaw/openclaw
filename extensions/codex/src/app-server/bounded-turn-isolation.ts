import {
  readCodexPluginConfig,
  resolveCodexAppServerHomeScope,
  resolveCodexAppServerRuntimeOptions,
} from "./config.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";

export type CodexBoundedTurnIsolation = "configured-transport" | "private-stdio";

export function resolveCodexBoundedTurnIsolation(options: {
  pluginConfig?: unknown;
}): CodexBoundedTurnIsolation {
  const pluginConfig = readCodexPluginConfig(options.pluginConfig);
  const homeScope = resolveCodexAppServerHomeScope({ appServer: pluginConfig.appServer });
  const { start } = resolveCodexAppServerRuntimeOptions({ pluginConfig: options.pluginConfig });
  return start.transport === "stdio" &&
    homeScope === "agent" &&
    !isCodexAppServerProxyLaunch(start.args)
    ? "private-stdio"
    : "configured-transport";
}
