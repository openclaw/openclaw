import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import type { ModelRef } from "./model-selection-normalize.js";
import { type ModelRefStatus } from "./model-selection-shared.js";
export { buildConfiguredAllowlistKeys, buildModelAliasIndex, normalizeModelSelection, resolveConfiguredModelRef, resolveHooksGmailModel, resolveModelRefFromString, } from "./model-selection-shared.js";
export type { ModelRefStatus } from "./model-selection-shared.js";
export declare function getModelRefStatus(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    ref: ModelRef;
    defaultProvider: string;
    defaultModel?: string;
}): ModelRefStatus;
export declare function resolveAllowedModelRef(params: {
    cfg: OpenClawConfig;
    catalog: ModelCatalogEntry[];
    raw: string;
    defaultProvider: string;
    defaultModel?: string;
}): {
    ref: ModelRef;
    key: string;
} | {
    error: string;
};
