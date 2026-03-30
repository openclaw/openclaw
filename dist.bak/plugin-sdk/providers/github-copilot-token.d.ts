export type CachedCopilotToken = {
    token: string;
    /** milliseconds since epoch */
    expiresAt: number;
    /** milliseconds since epoch */
    updatedAt: number;
};
export declare const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
export declare function deriveCopilotApiBaseUrlFromToken(token: string): string | null;
export declare function resolveCopilotApiToken(params: {
    githubToken: string;
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    cachePath?: string;
    loadJsonFileImpl?: (path: string) => unknown;
    saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
    token: string;
    expiresAt: number;
    source: string;
    baseUrl: string;
}>;
