import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
type SandboxHashInput = {
    docker: SandboxDockerConfig;
    workspaceAccess: SandboxWorkspaceAccess;
    workspaceDir: string;
    agentWorkspaceDir: string;
};
type SandboxBrowserHashInput = {
    docker: SandboxDockerConfig;
    browser: Pick<SandboxBrowserConfig, "cdpPort" | "cdpSourceRange" | "vncPort" | "noVncPort" | "headless" | "enableNoVnc">;
    securityEpoch: string;
    workspaceAccess: SandboxWorkspaceAccess;
    workspaceDir: string;
    agentWorkspaceDir: string;
};
export declare function computeSandboxConfigHash(input: SandboxHashInput): string;
export declare function computeSandboxBrowserConfigHash(input: SandboxBrowserHashInput): string;
export {};
