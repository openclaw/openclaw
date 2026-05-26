import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
export declare function createOperatorApprovalsGatewayClient(params: Pick<GatewayClientOptions, "clientDisplayName" | "onClose" | "onConnectError" | "onEvent" | "onHelloOk" | "onReconnectPaused"> & {
    config: OpenClawConfig;
    gatewayUrl?: string;
}): Promise<GatewayClient>;
export declare function withOperatorApprovalsGatewayClient<T>(params: {
    config: OpenClawConfig;
    gatewayUrl?: string;
    clientDisplayName: string;
}, run: (client: GatewayClient) => Promise<T>): Promise<T>;
