import type { GatewayBroadcastFn } from "../server-broadcast-types.js";
export declare function broadcastPresenceSnapshot(params: {
    broadcast: GatewayBroadcastFn;
    incrementPresenceVersion: () => number;
    getHealthVersion: () => number;
}): number;
