import type { OpenClawConfig } from "../config/config.js";
import type { SecretRef } from "../config/types.secrets.js";
export type SecretRefResolveCache = {
    resolvedByRefKey?: Map<string, Promise<unknown>>;
    filePayloadByProvider?: Map<string, Promise<unknown>>;
};
type ResolveSecretRefOptions = {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    cache?: SecretRefResolveCache;
};
export declare function resolveSecretRefValues(refs: SecretRef[], options: ResolveSecretRefOptions): Promise<Map<string, unknown>>;
export declare function resolveSecretRefValue(ref: SecretRef, options: ResolveSecretRefOptions): Promise<unknown>;
export declare function resolveSecretRefString(ref: SecretRef, options: ResolveSecretRefOptions): Promise<string>;
export {};
