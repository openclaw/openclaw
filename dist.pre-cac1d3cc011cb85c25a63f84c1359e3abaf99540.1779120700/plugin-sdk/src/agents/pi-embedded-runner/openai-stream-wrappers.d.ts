import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveOpenAITextVerbosity, type OpenAITextVerbosity } from "../openai-text-verbosity.js";
type OpenAIServiceTier = "auto" | "default" | "flex" | "priority";
export { resolveOpenAITextVerbosity };
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveOpenAIServiceTier(extraParams: Record<string, unknown> | undefined): OpenAIServiceTier | undefined;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function resolveOpenAIFastMode(extraParams: Record<string, unknown> | undefined): boolean | undefined;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIResponsesContextManagementWrapper(baseStreamFn: StreamFn | undefined, extraParams: Record<string, unknown> | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIReasoningCompatibilityWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIStringContentWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAICompletionsStrictMessageKeysWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAICompletionsToolsCompatWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIThinkingLevelWrapper(baseStreamFn: StreamFn | undefined, thinkingLevel?: ThinkLevel): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIFastModeWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIServiceTierWrapper(baseStreamFn: StreamFn | undefined, serviceTier: OpenAIServiceTier): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAITextVerbosityWrapper(baseStreamFn: StreamFn | undefined, verbosity: OpenAITextVerbosity): StreamFn;
/** @deprecated OpenAI Codex provider-owned stream helper; do not use from third-party plugins. */
export declare function createCodexNativeWebSearchWrapper(baseStreamFn: StreamFn | undefined, params: {
    config?: OpenClawConfig;
    agentDir?: string;
    codeModeToolSurfaceEnabled?: boolean;
}): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIDefaultTransportWrapper(baseStreamFn: StreamFn | undefined): StreamFn;
/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export declare function createOpenAIAttributionHeadersWrapper(baseStreamFn: StreamFn | undefined, opts?: {
    codexNativeTransportStreamFn?: StreamFn;
}): StreamFn;
