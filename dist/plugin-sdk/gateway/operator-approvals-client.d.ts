import type { OpenClawConfig } from "../config/config.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
export declare function createOperatorApprovalsGatewayClient(params: Pick<GatewayClientOptions, "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk"> & {
    config: OpenClawConfig;
    gatewayUrl?: string;
}): Promise<GatewayClient>;
