type HostExecEnvSanitizationResult = {
    env: Record<string, string>;
    rejectedOverrideBlockedKeys: string[];
    rejectedOverrideInvalidKeys: string[];
};
type HostExecEnvOverrideDiagnostics = {
    rejectedOverrideBlockedKeys: string[];
    rejectedOverrideInvalidKeys: string[];
};
export declare function normalizeEnvVarKey(rawKey: string, options?: {
    portable?: boolean;
}): string | null;
export declare function normalizeHostOverrideEnvVarKey(rawKey: string): string | null;
export declare function isDangerousHostEnvVarName(rawKey: string): boolean;
export declare function isDangerousHostInheritedEnvVarName(rawKey: string): boolean;
export declare function isDangerousHostEnvOverrideVarName(rawKey: string): boolean;
export declare function sanitizeHostExecEnvWithDiagnostics(params?: {
    baseEnv?: Record<string, string | undefined>;
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): HostExecEnvSanitizationResult;
export declare function inspectHostExecEnvOverrides(params?: {
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): HostExecEnvOverrideDiagnostics;
export declare function sanitizeHostExecEnv(params?: {
    baseEnv?: Record<string, string | undefined>;
    overrides?: Record<string, string> | null;
    blockPathOverrides?: boolean;
}): Record<string, string>;
export declare function sanitizeSystemRunEnvOverrides(params?: {
    overrides?: Record<string, string> | null;
    shellWrapper?: boolean;
}): Record<string, string> | undefined;
export {};
