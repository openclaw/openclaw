import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
type MoonshotThinkingType = "enabled" | "disabled";
export declare function shouldApplySiliconFlowThinkingOffCompat(params: {
    provider: string;
    modelId: string;
    thinkingLevel?: ThinkLevel;
}): boolean;
export declare function shouldApplyMoonshotPayloadCompat(params: {
    provider: string;
    modelId: string;
}): boolean;
export declare function createSiliconFlowThinkingWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function resolveMoonshotThinkingType(params: {
    configuredThinking: unknown;
    thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined;
export declare function createMoonshotThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType?: MoonshotThinkingType): StreamFn;
export {};
