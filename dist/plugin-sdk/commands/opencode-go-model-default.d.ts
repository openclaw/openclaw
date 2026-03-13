import type { OpenClawConfig } from "../config/config.js";
export declare const OPENCODE_GO_DEFAULT_MODEL_REF = "opencode-go/kimi-k2.5";
export declare function applyOpencodeGoModelDefault(cfg: OpenClawConfig): {
    next: OpenClawConfig;
    changed: boolean;
};
