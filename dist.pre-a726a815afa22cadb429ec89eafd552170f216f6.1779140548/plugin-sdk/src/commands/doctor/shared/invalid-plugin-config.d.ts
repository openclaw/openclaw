import type { OpenClawConfig } from "../../../config/types.openclaw.js";
export declare function maybeRepairInvalidPluginConfig(cfg: OpenClawConfig): {
    config: OpenClawConfig;
    changes: string[];
};
