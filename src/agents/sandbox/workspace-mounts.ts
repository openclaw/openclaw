import type { WorkspaceMountPropagation } from "../../config/types.sandbox.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 2;


function mainWorkspaceMountSpec(
  access: SandboxWorkspaceAccess,
  propagation: WorkspaceMountPropagation | undefined,
): string {
  const parts: string[] = [access === "rw" ? "rw" : "ro"];
  if (propagation && propagation !== "rprivate") {
    parts.push(propagation);
  }
  parts.push("z");
  return parts.join(",");
}

function formatManagedWorkspaceBind(params: {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}): string {
  return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
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
      formatManagedWorkspaceBind({
        hostPath: agentWorkspaceDir,
        containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
        readOnly: workspaceAccess === "ro",
      }),
    );
  }
}
