import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function ensureStaticModelAllowlistEntry(params: {
    cfg: OpenClawConfig;
    modelRef: string;
    defaultProvider?: string;
}): OpenClawConfig;
