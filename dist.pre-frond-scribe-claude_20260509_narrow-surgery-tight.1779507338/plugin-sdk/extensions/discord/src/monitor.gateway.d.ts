import type { DiscordGatewayHandle } from "./monitor/gateway-handle.js";
import { DiscordGatewayEvent, DiscordGatewaySupervisor } from "./monitor/gateway-supervisor.js";
export { getDiscordGatewayEmitter } from "./monitor/gateway-supervisor.js";
export type WaitForDiscordGatewayStopParams = {
    gateway?: DiscordGatewayHandle;
    abortSignal?: AbortSignal;
    gatewaySupervisor?: Pick<DiscordGatewaySupervisor, "attachLifecycle" | "detachLifecycle">;
    onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
    registerForceStop?: (forceStop: (err: unknown) => void) => void;
};
export declare function waitForDiscordGatewayStop(params: WaitForDiscordGatewayStopParams): Promise<void>;
