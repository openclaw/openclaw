import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
type LocalGatewayRequestContextParams = {
    deps: CliDeps;
    getRuntimeConfig: () => OpenClawConfig;
};
type LocalGatewayScopeParams = LocalGatewayRequestContextParams;
export declare function createLocalGatewayRequestContext(params: LocalGatewayRequestContextParams): GatewayRequestContext;
export declare function withLocalGatewayRequestScope<T>(params: LocalGatewayScopeParams, run: () => T): T;
export {};
