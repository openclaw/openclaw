import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function normalizeCompatibilityConfigValues(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
