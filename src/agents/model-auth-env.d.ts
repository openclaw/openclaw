export type EnvApiKeyResult = {
    apiKey: string;
    source: string;
};
export declare function resolveEnvApiKey(provider: string, env?: NodeJS.ProcessEnv): EnvApiKeyResult | null;
