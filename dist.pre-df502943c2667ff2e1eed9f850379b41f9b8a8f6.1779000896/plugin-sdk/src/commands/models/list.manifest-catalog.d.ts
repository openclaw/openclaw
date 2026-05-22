import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/index.js";
export declare function loadStaticManifestCatalogRowsForList(params: {
    cfg: OpenClawConfig;
    providerFilter?: string;
    env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[];
export declare function loadSupplementalManifestCatalogRowsForList(params: {
    cfg: OpenClawConfig;
    providerFilter?: string;
    env?: NodeJS.ProcessEnv;
}): readonly NormalizedModelCatalogRow[];
