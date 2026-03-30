import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxContext, SandboxDockerConfig, SandboxWorkspaceInfo } from "./types.js";
export declare function resolveSandboxDockerUser(params: {
    docker: SandboxDockerConfig;
    workspaceDir: string;
    stat?: (workspaceDir: string) => Promise<{
        uid: number;
        gid: number;
    }>;
}): Promise<SandboxDockerConfig>;
export declare function resolveSandboxContext(params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    workspaceDir?: string;
}): Promise<SandboxContext | null>;
export declare function ensureSandboxWorkspaceForSession(params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    workspaceDir?: string;
}): Promise<SandboxWorkspaceInfo | null>;
