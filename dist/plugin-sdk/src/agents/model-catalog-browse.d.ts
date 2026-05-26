import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
export declare const DEFAULT_MODEL_CATALOG_BROWSE_TIMEOUT_MS = 750;
export type ModelCatalogBrowseView = "default" | "configured" | "all";
export declare function loadModelCatalogForBrowse(params: {
    cfg: OpenClawConfig;
    view?: ModelCatalogBrowseView;
    loadCatalog: (params: {
        readOnly: boolean;
    }) => Promise<ModelCatalogEntry[]>;
    timeoutMs?: number;
    onTimeout?: (timeoutMs: number) => void;
}): Promise<ModelCatalogEntry[]>;
