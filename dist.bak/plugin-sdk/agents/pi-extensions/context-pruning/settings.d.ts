export type ContextPruningToolMatch = {
    allow?: string[];
    deny?: string[];
};
export type ContextPruningMode = "off" | "cache-ttl";
export type ContextPruningConfig = {
    mode?: ContextPruningMode;
    /** TTL to consider cache expired (duration string, default unit: minutes). */
    ttl?: string;
    keepLastAssistants?: number;
    softTrimRatio?: number;
    hardClearRatio?: number;
    minPrunableToolChars?: number;
    tools?: ContextPruningToolMatch;
    softTrim?: {
        maxChars?: number;
        headChars?: number;
        tailChars?: number;
    };
    hardClear?: {
        enabled?: boolean;
        placeholder?: string;
    };
};
export type EffectiveContextPruningSettings = {
    mode: Exclude<ContextPruningMode, "off">;
    ttlMs: number;
    keepLastAssistants: number;
    softTrimRatio: number;
    hardClearRatio: number;
    minPrunableToolChars: number;
    tools: ContextPruningToolMatch;
    softTrim: {
        maxChars: number;
        headChars: number;
        tailChars: number;
    };
    hardClear: {
        enabled: boolean;
        placeholder: string;
    };
};
export declare const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings;
export declare function computeEffectiveSettings(raw: unknown): EffectiveContextPruningSettings | null;
