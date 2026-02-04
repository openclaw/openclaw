import type { OpenClawConfig } from "../config/config.js";
import type { AgentBootstrapHookContext } from "../hooks/internal-hooks.js";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export async function applyBootstrapHookOverrides(params: {
  files: WorkspaceBootstrapFile[];
  workspaceDir: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId ?? "unknown";
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const context: AgentBootstrapHookContext = {
    workspaceDir: params.workspaceDir,
    bootstrapFiles: params.files,
    cfg: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId,
  };
  const event = createInternalHookEvent("agent", "bootstrap", sessionKey, context);
  await triggerInternalHook(event);
  const updated = (event.context as AgentBootstrapHookContext).bootstrapFiles;
  const internalResult = Array.isArray(updated) ? updated : params.files;

  // After internal hooks, run plugin hooks
  const hookRunner = getGlobalHookRunner();
  if (hookRunner?.hasHooks("agent_bootstrap")) {
    const result = await hookRunner.runAgentBootstrap(
      {
        files: internalResult.map((f) => ({
          name: f.name,
          path: f.path,
          content: f.content,
          missing: f.missing,
        })),
      },
      {
        agentId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
      },
    );
    if (result?.files) {
      return result.files as WorkspaceBootstrapFile[];
    }
  }

  return internalResult;
}
