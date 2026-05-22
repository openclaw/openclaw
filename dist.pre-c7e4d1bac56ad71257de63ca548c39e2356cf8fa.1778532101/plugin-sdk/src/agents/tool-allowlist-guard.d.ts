type ExplicitToolAllowlistSource = {
    label: string;
    entries: string[];
    enforceWhenToolsDisabled?: boolean;
};
export declare function collectExplicitToolAllowlistSources(sources: Array<{
    label: string;
    allow?: string[];
    enforceWhenToolsDisabled?: boolean;
}>): ExplicitToolAllowlistSource[];
export declare function buildEmptyExplicitToolAllowlistError(params: {
    sources: ExplicitToolAllowlistSource[];
    callableToolNames: string[];
    toolsEnabled: boolean;
    disableTools?: boolean;
}): Error | null;
export {};
