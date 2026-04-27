import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
export declare function resolveThinkingDefault(params: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    catalog?: ModelCatalogEntry[];
}): ThinkLevel;
export {};
