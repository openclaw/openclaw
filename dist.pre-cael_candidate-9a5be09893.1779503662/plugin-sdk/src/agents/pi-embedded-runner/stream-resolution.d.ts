import type { StreamFn } from "@earendil-works/pi-agent-core";
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
    model: EmbeddedRunAttemptParams["model"];
    resolvedApiKey?: string;
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
    sessionId: string;
    signal?: AbortSignal;
    model: EmbeddedRunAttemptParams["model"];
    resolvedApiKey?: string;
    authProfileId?: string;
    authStorage?: {
        getApiKey(provider: string): Promise<string | undefined>;
    };
}): StreamFn;
export declare const testing: {
    setPiNativeCodexResponsesStreamFnForTest(streamFn: StreamFn | undefined): void;
    resetPiNativeCodexResponsesStreamFnForTest(): void;
};
export { testing as __testing };
