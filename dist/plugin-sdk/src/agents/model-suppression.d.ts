import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function shouldSuppressBuiltInModelFromManifest(params: {
    provider?: string | null;
    id?: string | null;
    config?: OpenClawConfig;
}): boolean;
export declare function shouldSuppressBuiltInModel(params: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    config?: OpenClawConfig;
}): boolean;
export declare function shouldUnconditionallySuppress(params: {
    provider?: string | null;
    id?: string | null;
    config?: OpenClawConfig;
}): boolean;
export declare function buildSuppressedBuiltInModelError(params: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    config?: OpenClawConfig;
}): string | undefined;
export declare function buildShouldSuppressBuiltInModel(params: {
    config?: OpenClawConfig;
}): (input: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
}) => boolean;
