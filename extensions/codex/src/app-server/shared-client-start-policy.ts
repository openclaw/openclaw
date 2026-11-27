import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { AGENT_GIT_CONFIG_PARAMETERS } from "openclaw/plugin-sdk/process-runtime";
import { bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import type { CodexAppServerStartOptions, CodexPluginConfig } from "./config-contracts.js";
import { resolveCodexComputerUseConfig } from "./config-runtime.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import { withCodexAppServerGitConfig } from "./transport-stdio.js";

/** Prepare the exact process options shared by key selection and native startup. */
export async function prepareClientStartOptions(
  params: Parameters<typeof bridgeCodexAppServerStartOptions>[0],
): Promise<CodexAppServerStartOptions> {
  const startOptions = await bridgeCodexAppServerStartOptions(params);
  // Apply host policy after auth/environment filtering on every acquisition,
  // not only turns: otherwise catalog and resume paths select competing writers.
  return startOptions.transport === "stdio" && !isCodexAppServerProxyLaunch(startOptions.args)
    ? withCodexAppServerGitConfig(startOptions, AGENT_GIT_CONFIG_PARAMETERS)
    : startOptions;
}

export const loadRuntimeArtifact = createLazyRuntimeModule(() => import("./runtime-artifact.js"));

export function shouldTrackDesktopGeneration(
  startOptions: CodexAppServerStartOptions,
  pluginConfig: CodexPluginConfig | undefined,
): boolean {
  if (startOptions.transport !== "stdio") {
    return false;
  }
  // A managed package process can publish desktop-owned Computer Use artifacts,
  // so both share one generation. Custom operator commands remain independent.
  if (
    resolveCodexComputerUseConfig({ pluginConfig }).enabled &&
    (startOptions.commandSource === "managed" || startOptions.commandSource === "resolved-managed")
  ) {
    return true;
  }
  return (
    startOptions.commandSource === "managed" &&
    (startOptions.managedCommandOrder ?? "package-first") === "desktop-first"
  );
}
