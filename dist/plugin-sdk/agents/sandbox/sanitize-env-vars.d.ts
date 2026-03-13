export type EnvVarSanitizationResult = {
    allowed: Record<string, string>;
    blocked: string[];
    warnings: string[];
};
export type EnvSanitizationOptions = {
    strictMode?: boolean;
    customBlockedPatterns?: ReadonlyArray<RegExp>;
    customAllowedPatterns?: ReadonlyArray<RegExp>;
};
export declare function validateEnvVarValue(value: string): string | undefined;
export declare function sanitizeEnvVars(envVars: Record<string, string>, options?: EnvSanitizationOptions): EnvVarSanitizationResult;
export declare function getBlockedPatterns(): string[];
export declare function getAllowedPatterns(): string[];
