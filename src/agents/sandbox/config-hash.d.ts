import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
type SandboxHashInput = {
    docker: SandboxDockerConfig;
    workspaceAccess: SandboxWorkspaceAccess;
    workspaceDir: string;
    agentWorkspaceDir: string;
    mountFormatVersion: number;
};
type SandboxBrowserHashInput = {
    docker: SandboxDockerConfig;
    browser: Pick<SandboxBrowserConfig, "cdpPort" | "cdpSourceRange" | "vncPort" | "noVncPort" | "headless" | "enableNoVnc" | "autoStartTimeoutMs">;
    securityEpoch: string;
    workspaceAccess: SandboxWorkspaceAccess;
    workspaceDir: string;
    agentWorkspaceDir: string;
    mountFormatVersion: number;
};
export declare function computeSandboxConfigHash(input: SandboxHashInput): string;
export declare function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string;
export {};
