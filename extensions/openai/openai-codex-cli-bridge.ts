import type {
  CliBackendPreparedExecution,
  CliBackendPrepareExecutionContext,
} from "openclaw/plugin-sdk/cli-backend";
import { prepareCodexAuthBridgeFromProfile } from "openclaw/plugin-sdk/codex-auth-bridge-runtime";

export async function prepareOpenAICodexCliExecution(
  ctx: CliBackendPrepareExecutionContext,
): Promise<CliBackendPreparedExecution | null> {
  if (!ctx.agentDir || !ctx.authProfileId) {
    return null;
  }

  const bridge = await prepareCodexAuthBridgeFromProfile({
    agentDir: ctx.agentDir,
    authProfileId: ctx.authProfileId,
    bridgeRoot: "cli-auth",
  });
  if (!bridge) {
    return null;
  }

  return {
    env: {
      CODEX_HOME: bridge.codexHome,
    },
    clearEnv: bridge.clearEnv,
  };
}
