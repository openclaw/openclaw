import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function resolveModelCatalogScope(params: {
    cfg?: OpenClawConfig;
    provider: string;
    model: string;
}): {
    providerRefs: string[];
    modelRefs: string[];
};
export declare function resolveProviderDiscoveryProviderIdsForCatalogScope(params: {
    providerRefs?: readonly string[];
    modelRefs?: readonly string[];
}): string[] | undefined;
