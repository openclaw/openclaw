import type { SandboxWorkspaceAccess } from "./types.js";
export declare const SANDBOX_MOUNT_FORMAT_VERSION = 2;
export declare function appendWorkspaceMountArgs(params: {
    args: string[];
    workspaceDir: string;
    agentWorkspaceDir: string;
    workdir: string;
    workspaceAccess: SandboxWorkspaceAccess;
}): void;
