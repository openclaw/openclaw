import type { GatewayRequestHandlers, GatewayRequestOptions } from "./server-methods/types.js";
export declare const coreGatewayHandlers: GatewayRequestHandlers;
export declare function handleGatewayRequest(opts: GatewayRequestOptions & {
    extraHandlers?: GatewayRequestHandlers;
}): Promise<void>;
