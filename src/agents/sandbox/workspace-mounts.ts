import { resolveStateDir } from "../../config/paths.js";
import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
import type { SandboxWorkspaceAccess } from "./types.js";

export const SANDBOX_MOUNT_FORMAT_VERSION = 2;

/**
 * When the gateway runs inside a container, workspace paths are container-internal
 * (e.g. /home/node/.openclaw/workspace-forge). Docker Desktop needs host paths for
 * sibling container bind mounts. OPENCLAW_DOCKER_HOST_STATE_DIR provides the host-side
 * equivalent of the state dir so we can translate.
 */
function translateToDockerHostPath(containerPath: string): string {
  const hostStateDir = process.env.OPENCLAW_DOCKER_HOST_STATE_DIR?.trim();
  if (!hostStateDir) {
    return containerPath;
  }
  const stateDir = resolveStateDir();
  if (containerPath.startsWith(stateDir)) {
    return hostStateDir + containerPath.slice(stateDir.length);
  }
  return containerPath;
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
}) {
  const { args, workdir, workspaceAccess } = params;
  const workspaceDir = translateToDockerHostPath(params.workspaceDir);
  const agentWorkspaceDir = translateToDockerHostPath(params.agentWorkspaceDir);

  args.push(
    "-v",
    formatManagedWorkspaceBind({
      hostPath: workspaceDir,
      containerPath: workdir,
      readOnly: workspaceAccess !== "rw",
    }),
  );
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
