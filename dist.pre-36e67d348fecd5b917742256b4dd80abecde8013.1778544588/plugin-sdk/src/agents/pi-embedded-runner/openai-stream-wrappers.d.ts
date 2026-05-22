import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenAITextVerbosity, type OpenAITextVerbosity } from "../openai-text-verbosity.js";
type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
export { resolveOpenAITextVerbosity };
export declare function resolveOpenAIServiceTier(extraParams: Record<string, unknown> | undefined): OpenAIServiceTier | undefined;
export declare function resolveOpenAIFastMode(extraParams: Record<string, unknown> | undefined): boolean | undefined;
export declare function createOpenAIResponsesContextManagementWrapper(baseStreamFn: StreamFn | undefined, extraParams: Record<string, unknown> | undefined): StreamFn;
export declare function createOpenAIReasoningCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function createOpenAIStringContentWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function createOpenAIThinkingLevelWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
export declare function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function createOpenAIServiceTierWrapper(baseStreamFn: StreamFn | undefined, serviceTier: OpenAIServiceTier): StreamFn;
export declare function createOpenAITextVerbosityWrapper(baseStreamFn: StreamFn | undefined, verbosity: OpenAITextVerbosity): StreamFn;
export declare function createCodexNativeWebSearchWrapper(baseStreamFn: StreamFn | undefined, params: {
    config?: OpenClawConfig;
    agentDir?: string;
}): StreamFn;
export declare function createOpenAIDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
export declare function createOpenAIAttributionHeadersWrapper(baseStreamFn: StreamFn | undefined, opts?: {
    codexNativeTransportStreamFn?: StreamFn;
}): StreamFn;
