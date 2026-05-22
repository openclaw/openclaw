import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveSubagentThinkingOverride(params: {
    cfg: OpenClawConfig;
    targetAgentConfig?: unknown;
    thinkingOverrideRaw?: string;
}): {
    status: "ok";
    thinkingOverride: undefined;
    initialSessionPatch: {
        thinkingLevel?: undefined;
    };
    thinkingCandidateRaw?: undefined;
} | {
    status: "error";
    thinkingCandidateRaw: string;
    thinkingOverride?: undefined;
    initialSessionPatch?: undefined;
} | {
    thinkingCandidateRaw?: undefined;
    status: "ok";
    thinkingOverride: import("../auto-reply/thinking.shared.js").ThinkLevel;
    initialSessionPatch: {
        thinkingLevel: "adaptive" | "high" | "low" | "max" | "medium" | "minimal" | "xhigh" | null;
    };
};
