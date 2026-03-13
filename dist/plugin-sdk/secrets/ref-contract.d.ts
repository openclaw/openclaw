import { type SecretRef, type SecretRefSource } from "../config/types.secrets.js";
export declare const SECRET_PROVIDER_ALIAS_PATTERN: RegExp;
export declare const SINGLE_VALUE_FILE_REF_ID = "value";
export declare const FILE_SECRET_REF_ID_PATTERN: RegExp;
export declare const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN = "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$";
export type ExecSecretRefIdValidationReason = "pattern" | "traversal-segment";
export type ExecSecretRefIdValidationResult = {
    ok: true;
} | {
    ok: false;
    reason: ExecSecretRefIdValidationReason;
};
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
export declare function isValidSecretProviderAlias(value: string): boolean;
export declare function validateExecSecretRefId(value: string): ExecSecretRefIdValidationResult;
export declare function isValidExecSecretRefId(value: string): boolean;
export declare function formatExecSecretRefIdValidationMessage(): string;
