import type { OpenClawConfig } from "../../config/config.js";
import type { SandboxBrowserConfig, SandboxConfig, SandboxDockerConfig, SandboxPruneConfig, SandboxScope } from "./types.js";
export declare const DANGEROUS_SANDBOX_DOCKER_BOOLEAN_KEYS: readonly ["dangerouslyAllowReservedContainerTargets", "dangerouslyAllowExternalBindSources", "dangerouslyAllowContainerNamespaceJoin"];
export declare function resolveSandboxBrowserDockerCreateConfig(params: {
    docker: SandboxDockerConfig;
    browser: SandboxBrowserConfig;
}): SandboxDockerConfig;
export declare function resolveSandboxScope(params: {
    scope?: SandboxScope;
    perSession?: boolean;
}): SandboxScope;
export declare function resolveSandboxDockerConfig(params: {
    scope: SandboxScope;
    globalDocker?: Partial<SandboxDockerConfig>;
    agentDocker?: Partial<SandboxDockerConfig>;
}): SandboxDockerConfig;
export declare function resolveSandboxBrowserConfig(params: {
    scope: SandboxScope;
    globalBrowser?: Partial<SandboxBrowserConfig>;
    agentBrowser?: Partial<SandboxBrowserConfig>;
}): SandboxBrowserConfig;
export declare function resolveSandboxPruneConfig(params: {
    scope: SandboxScope;
    globalPrune?: Partial<SandboxPruneConfig>;
    agentPrune?: Partial<SandboxPruneConfig>;
}): SandboxPruneConfig;
export declare function resolveSandboxConfigForAgent(cfg?: OpenClawConfig, agentId?: string): SandboxConfig;
