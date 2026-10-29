import type { CodexPluginConfig } from "./config.js";
import {
  prepareCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";

export function preparePluginThreadConfigForTest(
  pluginConfig: CodexPluginConfig,
  appCacheKey: string,
  scheduledRuntimeAuthority?: Parameters<
    typeof resolveCodexPluginThreadConfigStartupPolicy
  >[0]["scheduledRuntimeAuthority"],
) {
  const prepare = prepareCodexPluginThreadConfigStartupProvider({
    startupPolicy: resolveCodexPluginThreadConfigStartupPolicy({
      pluginConfig,
      nativeToolSurfaceEnabled: true,
      scheduledRuntimeAuthority,
    }),
    appCacheKey,
    scheduledRuntimeAuthority,
  });
  if (!prepare) {
    throw new Error("Plugin configuration fixture must require a startup provider");
  }
  return prepare;
}
