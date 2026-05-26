import type { OpenClawConfig } from "../config/types.openclaw.js";
export type SecretInputUnresolvedReasonStyle = "generic" | "detailed";
type ConfiguredSecretInputSource = "config" | "secretRef" | "fallback";
export declare function resolveConfiguredSecretInputString(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    value: unknown;
    path: string;
    unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
    value?: string;
    unresolvedRefReason?: string;
}>;
export declare function resolveConfiguredSecretInputWithFallback(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    value: unknown;
    path: string;
    unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
    readFallback?: () => string | undefined;
}): Promise<{
    value?: string;
    source?: ConfiguredSecretInputSource;
    unresolvedRefReason?: string;
    secretRefConfigured: boolean;
}>;
export declare function resolveRequiredConfiguredSecretRefInputString(params: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    value: unknown;
    path: string;
    unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<string | undefined>;
export {};
