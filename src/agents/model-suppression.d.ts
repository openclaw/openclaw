import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function shouldSuppressBuiltInModel(params: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    config?: OpenClawConfig;
}): boolean;
export declare function buildSuppressedBuiltInModelError(params: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    config?: OpenClawConfig;
}): string | undefined;
