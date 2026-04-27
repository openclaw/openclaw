import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
export declare function resolveEmbeddedAgentBaseStreamFn(params: {
    session: {
        agent: {
            streamFn?: StreamFn;
        };
    };
}): StreamFn | undefined;
export declare function resetEmbeddedAgentBaseStreamFnCacheForTest(): void;
export declare function describeEmbeddedAgentStreamStrategy(params: {
    currentStreamFn: StreamFn | undefined;
    providerStreamFn?: StreamFn;
    shouldUseWebSocketTransport: boolean;
    wsApiKey?: string;
    model: EmbeddedRunAttemptParams["model"];
}): string;
export declare function resolveEmbeddedAgentApiKey(params: {
    provider: string;
    resolvedApiKey?: string;
    authStorage?: {
        getApiKey(provider: string): Promise<string | undefined>;
    };
}): Promise<string | undefined>;
export declare function resolveEmbeddedAgentStreamFn(params: {
    currentStreamFn: StreamFn | undefined;
    providerStreamFn?: StreamFn;
    shouldUseWebSocketTransport: boolean;
    wsApiKey?: string;
    sessionId: string;
    signal?: AbortSignal;
    model: EmbeddedRunAttemptParams["model"];
    resolvedApiKey?: string;
    authStorage?: {
        getApiKey(provider: string): Promise<string | undefined>;
    };
}): StreamFn;
