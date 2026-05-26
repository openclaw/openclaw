import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function noteDevicePairingHealth(params: {
    cfg: OpenClawConfig;
    healthOk: boolean;
}): Promise<void>;
