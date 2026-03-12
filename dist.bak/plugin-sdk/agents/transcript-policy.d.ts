import type { ToolCallIdMode } from "./tool-call-id.js";
export type TranscriptSanitizeMode = "full" | "images-only";
export type TranscriptPolicy = {
    sanitizeMode: TranscriptSanitizeMode;
    sanitizeToolCallIds: boolean;
    toolCallIdMode?: ToolCallIdMode;
    repairToolUseResultPairing: boolean;
    preserveSignatures: boolean;
    sanitizeThoughtSignatures?: {
        allowBase64Only?: boolean;
        includeCamelCase?: boolean;
    };
    sanitizeThinkingSignatures: boolean;
    dropThinkingBlocks: boolean;
    applyGoogleTurnOrdering: boolean;
    validateGeminiTurns: boolean;
    validateAnthropicTurns: boolean;
    allowSyntheticToolResults: boolean;
};
export declare function resolveTranscriptPolicy(params: {
    modelApi?: string | null;
    provider?: string | null;
    modelId?: string | null;
}): TranscriptPolicy;
