import { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE } from "../../internal-runtime-context.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };
type RuntimeContextSession = {
    sendCustomMessage: (message: {
        customType: string;
        content: string;
        display: boolean;
        details?: Record<string, unknown>;
    }, options?: {
        deliverAs?: "nextTurn";
        triggerTurn?: boolean;
    }) => Promise<void>;
};
type RuntimeContextPromptParts = {
    prompt: string;
    runtimeContext?: string;
    runtimeOnly?: boolean;
    runtimeSystemContext?: string;
};
export declare function resolveRuntimeContextPromptParts(params: {
    effectivePrompt: string;
    transcriptPrompt?: string;
}): RuntimeContextPromptParts;
export declare function buildRuntimeContextSystemContext(runtimeContext: string): string;
export declare function buildRuntimeEventSystemContext(runtimeContext: string): string;
export declare function queueRuntimeContextForNextTurn(params: {
    session: RuntimeContextSession;
    runtimeContext?: string;
}): Promise<void>;
