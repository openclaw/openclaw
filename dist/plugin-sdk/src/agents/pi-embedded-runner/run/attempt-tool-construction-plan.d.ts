import type { OpenClawCodingToolConstructionPlan } from "../../pi-tools.js";
export declare function applyEmbeddedAttemptToolsAllow<T extends {
    name: string;
}>(tools: T[], toolsAllow?: string[], options?: {
    toolMeta?: (tool: T) => {
        pluginId: string;
    } | undefined;
}): T[];
export declare function resolveEmbeddedAttemptToolConstructionPlan(params: {
    disableTools?: boolean;
    isRawModelRun?: boolean;
    toolsAllow?: string[];
}): {
    constructTools: boolean;
    includeCoreTools: boolean;
    runtimeToolAllowlist?: string[];
    codingToolConstructionPlan: OpenClawCodingToolConstructionPlan;
};
export declare function shouldBuildCoreCodingToolsForAllowlist(toolsAllow?: string[]): boolean;
export declare function shouldCreateBundleMcpRuntimeForAttempt(params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
}): boolean;
export declare function shouldCreateBundleLspRuntimeForAttempt(params: {
    toolsEnabled: boolean;
    disableTools?: boolean;
    toolsAllow?: string[];
}): boolean;
