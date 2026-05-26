import type { ConfigWriteOptions } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
type GatewayInstallTokenOptions = {
    config: OpenClawConfig;
    configSnapshot?: ConfigFileSnapshot;
    configWriteOptions?: ConfigWriteOptions;
    env: NodeJS.ProcessEnv;
    explicitToken?: string;
    autoGenerateWhenMissing?: boolean;
    persistGeneratedToken?: boolean;
};
type GatewayInstallTokenResolution = {
    token?: string;
    tokenRefConfigured: boolean;
    unavailableReason?: string;
    warnings: string[];
};
export declare function resolveGatewayInstallToken(options: GatewayInstallTokenOptions): Promise<GatewayInstallTokenResolution>;
export {};
