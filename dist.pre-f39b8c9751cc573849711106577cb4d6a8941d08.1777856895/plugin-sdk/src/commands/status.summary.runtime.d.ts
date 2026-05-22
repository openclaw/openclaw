import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
declare function resolveConfiguredStatusModelRef(params: {
    cfg: OpenClawConfig;
    defaultProvider: string;
    defaultModel: string;
    agentId?: string;
}): {
    provider: string;
    model: string;
};
declare function classifySessionKey(key: string, entry?: SessionEntry): "direct" | "global" | "group" | "unknown";
declare function resolveSessionModelRef(cfg: OpenClawConfig, entry?: SessionEntry | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">, agentId?: string): {
    provider: string;
    model: string;
};
declare function resolveContextTokensForModel(params: {
    cfg?: OpenClawConfig;
    provider?: string;
    model?: string;
    contextTokensOverride?: number;
    fallbackContextTokens?: number;
    allowAsyncLoad?: boolean;
}): number | undefined;
export declare const statusSummaryRuntime: {
    resolveContextTokensForModel: typeof resolveContextTokensForModel;
    classifySessionKey: typeof classifySessionKey;
    resolveSessionModelRef: typeof resolveSessionModelRef;
    resolveConfiguredStatusModelRef: typeof resolveConfiguredStatusModelRef;
};
export {};
