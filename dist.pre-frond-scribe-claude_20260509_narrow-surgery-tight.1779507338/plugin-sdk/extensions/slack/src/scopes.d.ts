export type SlackScopesResult = {
    ok: boolean;
    scopes?: string[];
    source?: string;
    error?: string;
};
export declare function fetchSlackScopes(token: string, timeoutMs: number): Promise<SlackScopesResult>;
