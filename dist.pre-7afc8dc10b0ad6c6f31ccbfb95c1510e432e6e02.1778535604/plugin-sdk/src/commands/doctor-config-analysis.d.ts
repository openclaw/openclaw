import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function formatConfigPath(parts: Array<string | number>): string;
export declare function resolveConfigPathTarget(root: unknown, path: Array<string | number>): unknown;
export declare function stripUnknownConfigKeys(config: OpenClawConfig): {
    config: OpenClawConfig;
    removed: string[];
};
export declare function noteOpencodeProviderOverrides(cfg: OpenClawConfig): void;
export declare function noteIncludeConfinementWarning(snapshot: {
    path?: string | null;
    issues?: Array<{
        message: string;
    }>;
}): void;
