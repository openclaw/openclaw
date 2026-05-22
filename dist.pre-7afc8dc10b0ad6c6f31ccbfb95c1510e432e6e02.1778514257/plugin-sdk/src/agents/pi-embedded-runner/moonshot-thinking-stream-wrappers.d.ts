import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
export declare function resolveMoonshotThinkingType(params: {
    configuredThinking: unknown;
    thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined;
export declare function resolveMoonshotThinkingKeep(params: {
    configuredThinking: unknown;
}): MoonshotThinkingKeep | undefined;
export declare function createMoonshotThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType?: MoonshotThinkingType, thinkingKeep?: MoonshotThinkingKeep): StreamFn;
export {};
