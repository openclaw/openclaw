import { SANDBOX_AGENT_WORKSPACE_MOUNT } from "./constants.js";
export const SANDBOX_MOUNT_FORMAT_VERSION = 2;
function formatManagedWorkspaceBind(params) {
    return `${params.hostPath}:${params.containerPath}:${params.readOnly ? "ro,z" : "z"}`;
}
export function appendWorkspaceMountArgs(params) {
    const { args, workspaceDir, agentWorkspaceDir, workdir, workspaceAccess } = params;
    args.push("-v", formatManagedWorkspaceBind({
        hostPath: workspaceDir,
        containerPath: workdir,
        readOnly: workspaceAccess !== "rw",
    }));
    if (workspaceAccess !== "none" && workspaceDir !== agentWorkspaceDir) {
        args.push("-v", formatManagedWorkspaceBind({
            hostPath: agentWorkspaceDir,
            containerPath: SANDBOX_AGENT_WORKSPACE_MOUNT,
            readOnly: workspaceAccess === "ro",
        }));
    }
}
