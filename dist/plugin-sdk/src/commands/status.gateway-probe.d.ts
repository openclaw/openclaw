import type { OpenClawConfig } from "../config/types.openclaw.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";
export declare function resolveGatewayProbeAuthResolution(cfg: OpenClawConfig): Promise<{
    auth: {
        token?: string;
        password?: string;
    };
    warning?: string;
}>;
export declare function resolveGatewayProbeAuth(cfg: OpenClawConfig): Promise<{
    token?: string;
    password?: string;
}>;
