import type { GatewayWsClient } from "./server/ws-types.js";
export type GatewayBroadcastStateVersion = {
    presence?: number;
    health?: number;
};
export type GatewayBroadcastOpts = {
    dropIfSlow?: boolean;
    stateVersion?: GatewayBroadcastStateVersion;
};
export type GatewayBroadcastFn = (event: string, payload: unknown, opts?: GatewayBroadcastOpts) => void;
export type GatewayBroadcastToConnIdsFn = (event: string, payload: unknown, connIds: ReadonlySet<string>, opts?: GatewayBroadcastOpts) => void;
export declare function createGatewayBroadcaster(params: {
    clients: Set<GatewayWsClient>;
}): {
    broadcast: GatewayBroadcastFn;
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
};
