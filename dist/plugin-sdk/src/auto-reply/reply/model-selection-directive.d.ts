export type ModelAliasIndex = {
    byAlias: Map<string, {
        alias: string;
        ref: {
            provider: string;
            model: string;
        };
    }>;
    byKey: Map<string, string[]>;
};
export type ModelDirectiveSelection = {
    provider: string;
    model: string;
    isDefault: boolean;
    alias?: string;
};
export declare function modelKey(provider: string, model: string): string;
export declare function resolveModelRefFromDirectiveString(params: {
    raw: string;
    defaultProvider: string;
    aliasIndex: ModelAliasIndex;
}): {
    ref: {
        provider: string;
        model: string;
    };
    alias?: string;
} | null;
export declare function resolveModelDirectiveSelection(params: {
    raw: string;
    defaultProvider: string;
    defaultModel: string;
    aliasIndex: ModelAliasIndex;
    allowedModelKeys: Set<string>;
    rawRuntime?: string | undefined;
}): {
    selection?: ModelDirectiveSelection;
    error?: string;
};
