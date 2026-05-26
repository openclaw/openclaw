import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
type MoonshotThinkingType = "enabled" | "disabled";
type MoonshotThinkingKeep = "all";
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveMoonshotThinkingType(params: {
    configuredThinking: unknown;
    thinkingLevel?: ThinkLevel;
}): MoonshotThinkingType | undefined;
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveMoonshotThinkingKeep(params: {
    configuredThinking: unknown;
}): MoonshotThinkingKeep | undefined;
/** @deprecated Moonshot provider-owned stream helper; do not use from third-party plugins. */
export declare function createMoonshotThinkingWrapper(baseStreamFn: StreamFn | undefined, thinkingType?: MoonshotThinkingType, thinkingKeep?: MoonshotThinkingKeep): StreamFn;
export {};
