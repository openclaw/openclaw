import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildAgentMainSessionKey, normalizeMainKey } from "../../routing/session-key.js";
import { resolveAgentWorkspaceDir } from "../agent-scope.js";
import { resolveIngressWorkspaceOverrideForSessionRun } from "../spawned-context.js";
import { getSandboxBackendWorkdirResolver } from "./backend.js";
import { resolveSandboxConfigForAgent } from "./config.js";
import { buildSandboxFsMounts } from "./fs-paths.js";
import { resolveSandboxRuntimeStatus } from "./runtime-status.js";
import { resolveSandboxWorkspaceLayoutPaths } from "./shared.js";

/** Resolves a session's sandbox workspace layout and local container mounts without provisioning. */
export function resolveSandboxSessionWorkspace(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry | null;
}) {
  const { cfg, agentId, sessionKey, sessionEntry } = params;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey,
    agentId,
    classificationAgentId: agentId,
    preparedSessionEntry: sessionEntry ?? null,
  });
  const configuredSandbox = resolveSandboxConfigForAgent(cfg, agentId);
  const sandboxCfg = sandboxRuntime.sandboxRequired
    ? {
        ...configuredSandbox,
        scope: "agent" as const,
        workspaceAccess: sandboxRuntime.workspaceAccess,
      }
    : configuredSandbox;
  const sessionIsSandboxed = sandboxRuntime.sandboxed;
  // Spawned sessions persist their inherited workspace and direct-mode cwd so
  // later turns keep running in the same location.
  const effectiveAgentWorkspaceDir =
    resolveIngressWorkspaceOverrideForSessionRun({
      spawnedBy: sessionEntry?.spawnedBy,
      workspaceDir: sessionEntry?.spawnedWorkspaceDir,
      cwd: sessionEntry?.spawnedCwd,
    }) ?? resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceLayout = resolveSandboxWorkspaceLayoutPaths({
    cfg: sandboxCfg,
    agentId,
    isolationSubject: sandboxRuntime.isolationSubject,
    rawSessionKey:
      sessionKey === "global"
        ? buildAgentMainSessionKey({ agentId, mainKey: normalizeMainKey(cfg.session?.mainKey) })
        : sessionKey,
    workspaceDir: effectiveAgentWorkspaceDir,
  });
  const sandboxWorkdir = getSandboxBackendWorkdirResolver(sandboxCfg.backend)?.({
    sessionKey,
    scopeKey: workspaceLayout.scopeKey,
    workspaceDir: workspaceLayout.workspaceDir,
    agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
    skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
    cfg: sandboxCfg,
  });
  const usesLocalContainerMounts =
    sandboxCfg.backend.toLowerCase() === "docker" || sandboxCfg.backend.toLowerCase() === "podman";
  const workspaceMounts =
    sessionIsSandboxed && usesLocalContainerMounts && sandboxWorkdir
      ? buildSandboxFsMounts({
          workspaceDir: workspaceLayout.workspaceDir,
          agentWorkspaceDir: workspaceLayout.agentWorkspaceDir,
          skillsWorkspaceDir: workspaceLayout.skillsWorkspaceDir,
          workspaceAccess: sandboxCfg.workspaceAccess,
          containerName: "",
          containerWorkdir: sandboxWorkdir,
          docker: sandboxCfg.docker,
        })
      : [];
  return {
    sandboxRuntime,
    sandboxCfg,
    sessionIsSandboxed,
    effectiveAgentWorkspaceDir,
    workspaceLayout,
    sandboxWorkdir,
    workspaceMounts,
  };
}
