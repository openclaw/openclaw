import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { type ModelVisibilityPolicy } from "./model-selection-shared.js";
export declare function createModelVisibilityPolicy(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    defaultProvider: string;
    defaultModel?: string;
    agentId?: string;
}): ModelVisibilityPolicy;
export type { ModelVisibilityPolicy };
