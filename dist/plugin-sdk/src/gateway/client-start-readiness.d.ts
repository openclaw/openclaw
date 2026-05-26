import type { GatewayClient, GatewayClientOptions } from "./client.js";
import { type EventLoopReadyResult } from "./event-loop-ready.js";
export type GatewayClientStartReadinessOptions = {
    timeoutMs?: number;
    clientOptions?: Pick<GatewayClientOptions, "connectChallengeTimeoutMs" | "connectDelayMs" | "preauthHandshakeTimeoutMs">;
    signal?: AbortSignal;
};
export declare function startGatewayClientWhenEventLoopReady(client: GatewayClient, options?: GatewayClientStartReadinessOptions): Promise<EventLoopReadyResult>;
