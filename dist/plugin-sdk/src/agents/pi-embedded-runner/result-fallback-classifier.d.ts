import type { ModelFallbackResultClassification } from "../model-fallback.js";
export declare function classifyEmbeddedPiRunResultForModelFallback(params: {
    provider: string;
    model: string;
    result: unknown;
    hasDirectlySentBlockReply?: boolean;
    hasBlockReplyPipelineOutput?: boolean;
}): ModelFallbackResultClassification;
