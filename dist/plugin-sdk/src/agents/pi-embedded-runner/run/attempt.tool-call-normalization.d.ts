import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import { type ToolCallIdMode } from "../../tool-call-id.js";
import type { TranscriptPolicy } from "../../transcript-policy.js";
export declare function wrapStreamFnTrimToolCallNames(baseFn: StreamFn, allowedToolNames?: Set<string>, guardOptions?: {
    unknownToolThreshold?: number;
}): StreamFn;
type ReplayToolCallIdSanitizerDecision = {
    sanitizeToolCallIds: boolean;
    toolCallIdMode?: ToolCallIdMode;
    isOpenAIResponsesApi: boolean;
};
export declare function shouldApplyReplayToolCallIdSanitizer(params: ReplayToolCallIdSanitizerDecision): params is ReplayToolCallIdSanitizerDecision & {
    toolCallIdMode: ToolCallIdMode;
};
export declare function sanitizeReplayToolCallIdsForStream(params: {
    messages: AgentMessage[];
    mode: ToolCallIdMode;
    allowedToolNames?: Set<string>;
    preserveNativeAnthropicToolUseIds?: boolean;
    preserveReplaySafeThinkingToolCallIds?: boolean;
    repairToolUseResultPairing?: boolean;
}): AgentMessage[];
export declare function wrapStreamFnSanitizeMalformedToolCalls(baseFn: StreamFn, allowedToolNames?: Set<string>, transcriptPolicy?: Pick<TranscriptPolicy, "validateGeminiTurns" | "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks">): StreamFn;
export {};
