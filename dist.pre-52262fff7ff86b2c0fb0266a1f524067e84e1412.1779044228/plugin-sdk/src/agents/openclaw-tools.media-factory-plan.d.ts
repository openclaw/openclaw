import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
export type OptionalMediaToolFactoryPlan = {
    imageGenerate: boolean;
    videoGenerate: boolean;
    musicGenerate: boolean;
    pdf: boolean;
};
export declare function isToolExplicitlyAllowedByFactoryPolicy(params: {
    toolName: string;
    allowlist?: string[];
    denylist?: string[];
}): boolean;
export declare function mergeFactoryPolicyList(...lists: Array<string[] | undefined>): string[] | undefined;
export declare function resolveImageToolFactoryAvailable(params: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    modelHasVision?: boolean;
    authStore?: AuthProfileStore;
}): boolean;
export declare function resolveOptionalMediaToolFactoryPlan(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    authStore?: AuthProfileStore;
    toolAllowlist?: string[];
    toolDenylist?: string[];
}): OptionalMediaToolFactoryPlan;
