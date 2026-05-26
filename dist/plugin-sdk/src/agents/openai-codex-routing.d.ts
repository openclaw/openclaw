import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare const OPENAI_PROVIDER_ID = "openai";
export declare const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
export declare function isOpenAIProvider(provider: string | undefined): boolean;
export declare function isOpenAICodexProvider(provider: string | undefined): boolean;
export declare function openAIProviderUsesCodexRuntimeByDefault(params: {
    provider?: string;
    config?: OpenClawConfig;
}): boolean;
export declare function parseModelRefProvider(value: unknown): string | undefined;
export declare function modelRefUsesOpenAIProvider(value: unknown): boolean;
export declare function modelSelectionShouldEnsureCodexPlugin(params: {
    model?: string;
    config?: OpenClawConfig;
}): boolean;
export declare function hasOpenAICodexAuthProfileOverride(value: unknown): boolean;
export declare function shouldRouteOpenAIPiThroughCodexAuthProvider(params: {
    provider: string;
    harnessRuntime?: string;
    agentHarnessId?: string;
    authProfileProvider?: string;
    authProfileId?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
}): boolean;
export declare function listOpenAIAuthProfileProvidersForAgentRuntime(params: {
    provider: string;
    harnessRuntime?: string;
    agentHarnessId?: string;
    config?: OpenClawConfig;
}): string[];
export declare function resolveOpenAIRuntimeProviderForPi(params: {
    provider: string;
    harnessRuntime?: string;
    agentHarnessId?: string;
    authProfileProvider?: string;
    authProfileId?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
}): string;
export declare function resolveSelectedOpenAIPiRuntimeProvider(params: {
    provider: string;
    harnessRuntime?: string;
    agentHarnessId?: string;
    authProfileProvider?: string;
    authProfileId?: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
}): string;
export declare function resolveContextConfigProviderForRuntime(params: {
    provider: string;
    runtimeId?: string;
}): string;
