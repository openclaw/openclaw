export type ResolvedProviderAuth = {
    apiKey?: string;
    profileId?: string;
    source: string;
    mode: "api-key" | "oauth" | "token" | "aws-sdk";
};
export declare function resolveAwsSdkEnvVarName(env?: NodeJS.ProcessEnv): string | undefined;
export declare function requireApiKey(auth: ResolvedProviderAuth, provider: string): string;
