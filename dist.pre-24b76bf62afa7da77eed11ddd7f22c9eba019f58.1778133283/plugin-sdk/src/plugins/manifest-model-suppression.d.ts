import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function buildManifestBuiltInModelSuppressionResolver(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): (input: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    unconditionalOnly?: boolean;
}) => {
    suppress: boolean;
    errorMessage: string;
} | undefined;
/**
 * Resolves whether a built-in model should be suppressed based on manifest declarations.
 *
 * Note: This function instantiates a fresh resolver on every call, which incurs a full
 * filesystem scan of the manifest registry. For hot paths (like building the model catalog),
 * instantiate and reuse `buildManifestBuiltInModelSuppressionResolver` instead.
 */
export declare function resolveManifestBuiltInModelSuppression(params: {
    provider?: string | null;
    id?: string | null;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    baseUrl?: string | null;
    unconditionalOnly?: boolean;
}): {
    suppress: boolean;
    errorMessage: string;
} | undefined;
