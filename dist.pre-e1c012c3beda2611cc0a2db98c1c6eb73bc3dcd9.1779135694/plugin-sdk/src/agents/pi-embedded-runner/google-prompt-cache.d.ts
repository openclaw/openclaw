import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildGuardedModelFetch } from "../provider-transport-fetch.js";
type CustomEntryLike = {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
};
type GooglePromptCacheSessionManager = {
    appendCustomEntry(customType: string, data?: unknown): void | Promise<void>;
    getEntries(): CustomEntryLike[];
};
type GooglePromptCacheModel = Model<Api> & {
    baseUrl?: string;
    headers?: Record<string, string>;
    provider: string;
};
type PrepareGooglePromptCacheStreamFnParams = {
    apiKey?: string;
    extraParams?: Record<string, unknown>;
    model: GooglePromptCacheModel;
    modelId: string;
    provider: string;
    sessionManager: GooglePromptCacheSessionManager;
    signal?: AbortSignal;
    streamFn: StreamFn | undefined;
    systemPrompt?: string;
};
type GooglePromptCacheDeps = {
    buildGuardedFetch?: typeof buildGuardedModelFetch;
    now?: () => number;
};
export declare function prepareGooglePromptCacheStreamFn(params: PrepareGooglePromptCacheStreamFnParams, deps?: GooglePromptCacheDeps): Promise<StreamFn | undefined>;
export {};
