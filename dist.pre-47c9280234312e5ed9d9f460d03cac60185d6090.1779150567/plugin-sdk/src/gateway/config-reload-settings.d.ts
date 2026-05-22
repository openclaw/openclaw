import type { GatewayReloadMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type GatewayReloadSettings = {
    mode: GatewayReloadMode;
    debounceMs: number;
};
export declare function resolveGatewayReloadSettings(cfg: OpenClawConfig): GatewayReloadSettings;
