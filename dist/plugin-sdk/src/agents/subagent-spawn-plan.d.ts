import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function splitModelRef(ref?: string): {
    provider: undefined;
    model: undefined;
} | {
    provider: string;
    model: string;
} | {
    provider: undefined;
    model: string;
};
export declare function resolveConfiguredSubagentRunTimeoutSeconds(params: {
    cfg: OpenClawConfig;
    runTimeoutSeconds?: number;
}): number;
export declare function resolveSubagentModelAndThinkingPlan(params: {
    cfg: OpenClawConfig;
    targetAgentId: string;
    targetAgentConfig?: unknown;
    modelOverride?: string;
    thinkingOverrideRaw?: string;
}): {
    thinkingOverride?: undefined;
    initialSessionPatch?: undefined;
    status: "error";
    resolvedModel: string;
    error: string;
    modelApplied?: undefined;
} | {
    error?: undefined;
    status: "ok";
    resolvedModel: string;
    modelApplied: boolean;
    thinkingOverride: import("../auto-reply/thinking.shared.ts").ThinkLevel | undefined;
    initialSessionPatch: {
        thinkingLevel?: undefined;
        model?: string | undefined;
        modelOverrideSource?: string | undefined;
    } | {
        thinkingLevel: "adaptive" | "high" | "low" | "max" | "medium" | "minimal" | "xhigh" | null;
        model?: string | undefined;
        modelOverrideSource?: string | undefined;
    };
};
