import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexAppServerStartOptionsForAgent,
} from "./src/app-server/config.js";
import { resolveManagedCodexClientVersion } from "./src/app-server/managed-binary.js";
import { CODEX_APP_SERVER_VERSION } from "./src/app-server/version.js";

/**
 * Codex client version for ChatGPT model discovery: the version of the binary
 * managed turns run, so listed models match what the backend accepts for them.
 * Custom commands and remote app-servers keep reporting the bundled pin.
 */
export async function resolveCodexClientVersion(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<string> {
  const { start } = resolveCodexAppServerRuntimeOptions({
    pluginConfig: params.config?.plugins?.entries?.codex?.config,
    env: params.env,
  });
  if (start.transport !== "stdio" || start.commandSource !== "managed") {
    return CODEX_APP_SERVER_VERSION;
  }
  // Same agent-home Computer Use check that managed turns run before spawning.
  const agentStart = params.agentDir
    ? resolveCodexAppServerStartOptionsForAgent({
        startOptions: start,
        agentDir: params.agentDir,
        env: params.env,
      })
    : start;
  return resolveManagedCodexClientVersion(agentStart.managedCommandOrder ?? "package-first");
}
