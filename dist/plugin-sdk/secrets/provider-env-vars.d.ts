export declare const PROVIDER_ENV_VARS: Record<string, readonly string[]>;
export declare function listKnownProviderAuthEnvVarNames(): string[];
export declare function listKnownSecretEnvVarNames(): string[];
export declare function omitEnvKeysCaseInsensitive(baseEnv: NodeJS.ProcessEnv, keys: Iterable<string>): NodeJS.ProcessEnv;
