import path from "node:path";
import type { AgentSandboxConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readGatewayLockProcessNamespace } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { resolveSandboxContext } from "./context.js";
import { resolvePreparedSandboxRuntimeStatus } from "./runtime-status.js";

export function createConfig(
  sandbox: AgentSandboxConfig,
  config: OpenClawConfig = {},
): OpenClawConfig {
  return {
    ...config,
    agents: {
      defaults: {
        ...config.agents?.defaults,
        sandbox: {
          mode: "all",
          workspaceAccess: "rw",
          prune: { idleHours: 0, maxAgeDays: 0 },
          ...sandbox,
        },
      },
    },
  };
}

export function acquireOwner(root: string) {
  return acquireGatewayStateOwner({
    databasePath: resolveOpenClawStateSqlitePath(),
    payload: {
      pid: process.pid,
      processNamespace: readGatewayLockProcessNamespace(),
      createdAt: new Date().toISOString(),
      configPath: path.join(root, "openclaw.json"),
      role: "gateway",
    },
  });
}

export function prepareContext(config: OpenClawConfig, sessionKey: string, workspaceDir: string) {
  return resolveSandboxContext({
    config,
    sessionKey,
    workspaceDir,
    preparedRuntimeStatus: resolvePreparedSandboxRuntimeStatus({
      cfg: config,
      sessionKey,
      preparedSessionEntry: null,
    }),
  });
}
