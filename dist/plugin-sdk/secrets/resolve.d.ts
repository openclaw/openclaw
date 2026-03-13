import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef, SecretRefSource } from "../config/types.secrets.js";
export type SecretRefResolveCache = {
    resolvedByRefKey?: Map<string, Promise<unknown>>;
    filePayloadByProvider?: Map<string, Promise<unknown>>;
};
type ResolveSecretRefOptions = {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    cache?: SecretRefResolveCache;
};
export declare class SecretProviderResolutionError extends Error {
    readonly scope: "provider";
    readonly source: SecretRefSource;
    readonly provider: string;
    constructor(params: {
        source: SecretRefSource;
        provider: string;
        message: string;
        cause?: unknown;
    });
}
export declare class SecretRefResolutionError extends Error {
    readonly scope: "ref";
    readonly source: SecretRefSource;
    readonly provider: string;
    readonly refId: string;
    constructor(params: {
        source: SecretRefSource;
        provider: string;
        refId: string;
        message: string;
        cause?: unknown;
    });
}
export declare function isProviderScopedSecretResolutionError(value: unknown): value is SecretProviderResolutionError;
export declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
export declare function resolveSecretRefValue(ref: SecretRef, options: ResolveSecretRefOptions): Promise<unknown>;
export declare function resolveSecretRefString(ref: SecretRef, options: ResolveSecretRefOptions): Promise<string>;
export {};
