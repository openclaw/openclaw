import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export declare function validateConfigObjectRaw(raw: unknown): {
    ok: true;
    config: OpenClawConfig;
} | {
    ok: false;
    issues: ConfigValidationIssue[];
};
export declare function validateConfigObject(raw: unknown): {
    ok: true;
    config: OpenClawConfig;
} | {
    ok: false;
    issues: ConfigValidationIssue[];
};
export declare function validateConfigObjectWithPlugins(raw: unknown): {
    ok: true;
    config: OpenClawConfig;
    warnings: ConfigValidationIssue[];
} | {
    ok: false;
    issues: ConfigValidationIssue[];
    warnings: ConfigValidationIssue[];
};
export declare function validateConfigObjectRawWithPlugins(raw: unknown): {
    ok: true;
    config: OpenClawConfig;
    warnings: ConfigValidationIssue[];
} | {
    ok: false;
    issues: ConfigValidationIssue[];
    warnings: ConfigValidationIssue[];
};
