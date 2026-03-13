import type { OpenClawConfig } from "../config/config.js";
export declare function ensureModelAllowlistEntry(params: {
    cfg: OpenClawConfig;
    modelRef: string;
    defaultProvider?: string;
}): OpenClawConfig;
