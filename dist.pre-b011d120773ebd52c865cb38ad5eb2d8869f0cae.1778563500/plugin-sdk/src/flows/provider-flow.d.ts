import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { FlowContribution, FlowOption } from "./types.js";
type ProviderFlowScope = "text-inference" | "image-generation";
type ProviderSetupFlowOption = FlowOption & {
    onboardingScopes?: ProviderFlowScope[];
};
type ProviderSetupFlowContribution = FlowContribution & {
    kind: "provider";
    surface: "setup";
    providerId: string;
    pluginId?: string;
    option: ProviderSetupFlowOption;
    onboardingScopes?: ProviderFlowScope[];
    source: "manifest" | "install-catalog";
};
export declare function resolveProviderSetupFlowContributions(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    scope?: ProviderFlowScope;
}): ProviderSetupFlowContribution[];
export {};
