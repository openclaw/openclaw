import { type SecretRef, type SecretRefSource } from "../config/types.secrets.js";
export declare const SINGLE_VALUE_FILE_REF_ID = "value";
export type SecretRefDefaultsCarrier = {
    secrets?: {
        defaults?: {
            env?: string;
            file?: string;
            exec?: string;
        };
        providers?: Record<string, {
            source?: string;
        }>;
    };
};
export declare function secretRefKey(ref: SecretRef): string;
export declare function resolveDefaultSecretProviderAlias(config: SecretRefDefaultsCarrier, source: SecretRefSource, options?: {
    preferFirstProviderForSource?: boolean;
}): string;
export declare function isValidFileSecretRefId(value: string): boolean;
