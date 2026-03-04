import { SANDBOX_AGENT_WORKSPACE_MOUNT, SANDBOX_BUNDLED_SKILLS_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

function mainWorkspaceMountSuffix(access: SandboxWorkspaceAccess): "" | ":ro" {
  return access === "rw" ? "" : ":ro";
}

function agentWorkspaceMountSuffix(access: SandboxWorkspaceAccess): "" | ":ro" {
  return access === "ro" ? ":ro" : "";
}

export function appendWorkspaceMountArgs(params: {
  args: string[];
  workspaceDir: string;
  agentWorkspaceDir: string;
  workdir: string;
  workspaceAccess: SandboxWorkspaceAccess;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  args.push("-v", `${workspaceDir}:${workdir}${mainWorkspaceMountSuffix(workspaceAccess)}`);
  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      `${agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentWorkspaceMountSuffix(workspaceAccess)}`,
    );
  }
}

/**
 * Mount the bundled skills directory into the container as a read-only bind so that
 * sandboxed agents can read `SKILL.md` files that are referenced in the system prompt.
 * Without this, every skill invocation fails with "Path escapes sandbox root" because
 * the skills live in the npm-installed package directory, not in the workspace.
 */
export function appendBundledSkillsMountArgs(params: { args: string[]; bundledSkillsDir: string }) {
  params.args.push("-v", `${params.bundledSkillsDir}:${SANDBOX_BUNDLED_SKILLS_MOUNT}:ro`);
}
