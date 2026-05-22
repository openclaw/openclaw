import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function isAcpRuntimeSpawnAvailable(params: {
    config?: OpenClawConfig;
    sandboxed?: boolean;
    backendId?: string;
}): boolean;
