import type { SandboxBrowserConfig, SandboxDockerConfig, SandboxWorkspaceAccess } from "./types.js";
export declare const SANDBOX_DOCKER_EXPLICIT_ENV_POLICY_EPOCH = "explicit-config-env-v1";
type SandboxHashInput = {
    docker: SandboxDockerConfig;
    dockerEnvPolicyEpoch?: string;
    workspaceAccess: SandboxWorkspaceAccess;
    workspaceDir: string;
    agentWorkspaceDir: string;
    mountFormatVersion: number;
};
type SandboxBrowserHashInput = {
    docker: SandboxDockerConfig;
    dockerEnvPolicyEpoch?: string;
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
