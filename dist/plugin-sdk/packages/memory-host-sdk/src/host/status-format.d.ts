export type Tone = "ok" | "warn" | "muted";
export declare function resolveMemoryVectorState(vector: {
    enabled: boolean;
    available?: boolean;
}): {
    tone: Tone;
    state: "ready" | "unavailable" | "disabled" | "unknown";
};
export declare function resolveMemoryFtsState(fts: {
    enabled: boolean;
    available: boolean;
}): {
    tone: Tone;
    state: "ready" | "unavailable" | "disabled";
};
export declare function resolveMemoryCacheSummary(cache: {
    enabled: boolean;
    entries?: number;
}): {
    tone: Tone;
    text: string;
};
export declare function resolveMemoryCacheState(cache: {
    enabled: boolean;
}): {
    tone: Tone;
    state: "enabled" | "disabled";
};
