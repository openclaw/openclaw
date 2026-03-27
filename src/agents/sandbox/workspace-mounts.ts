import type { WorkspaceMountPropagation } from "../../config/types.sandbox.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

function mainWorkspaceMountSpec(
  access: SandboxWorkspaceAccess,
  propagation: WorkspaceMountPropagation | undefined,
): string {
  const parts: string[] = [access === "rw" ? "rw" : "ro"];
  if (propagation && propagation !== "rprivate") {
    parts.push(propagation);
  }
  return parts.join(",");
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
  workspaceMountPropagation?: WorkspaceMountPropagation;
}) {
  const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;

  const spec = mainWorkspaceMountSpec(workspaceAccess, params.workspaceMountPropagation);
  args.push("-v", `${workspaceDir}:${workdir}:${spec}`);
  if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
    args.push(
      "-v",
      `${agentWorkspaceDir}:${SANDBOX_AGENT_WORKSPACE_MOUNT}${agentWorkspaceMountSuffix(workspaceAccess)}`,
    );
  }
}
