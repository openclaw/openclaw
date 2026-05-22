import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../plugins/provider-runtime-model.types.js";
import type { ToolCallIdMode } from "./tool-call-id.js";
export type TranscriptSanitizeMode = "full" | "images-only";
export type TranscriptPolicy = {
    sanitizeMode: TranscriptSanitizeMode;
    sanitizeToolCallIds: boolean;
    toolCallIdMode?: ToolCallIdMode;
    preserveNativeAnthropicToolUseIds: boolean;
    repairToolUseResultPairing: boolean;
    preserveSignatures: boolean;
    sanitizeThoughtSignatures?: {
        allowBase64Only?: boolean;
        includeCamelCase?: boolean;
    };
    sanitizeThinkingSignatures: boolean;
    dropThinkingBlocks: boolean;
    dropReasoningFromHistory?: boolean;
    applyGoogleTurnOrdering: boolean;
    validateGeminiTurns: boolean;
    validateAnthropicTurns: boolean;
    allowSyntheticToolResults: boolean;
};
export declare function shouldAllowProviderOwnedThinkingReplay(params: {
    modelApi?: string | null;
    policy: Pick<TranscriptPolicy, "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks">;
}): boolean;
export declare function resolveTranscriptPolicy(params: {
    modelApi?: string | null;
    provider?: string | null;
    modelId?: string | null;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    model?: ProviderRuntimeModel;
}): TranscriptPolicy;
