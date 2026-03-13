import type { EventEmitter } from "node:events";
export type DiscordGatewayHandle = {
    emitter?: Pick<EventEmitter, "on" | "removeListener">;
    disconnect?: () => void;
};
export type WaitForDiscordGatewayStopParams = {
    gateway?: DiscordGatewayHandle;
    abortSignal?: AbortSignal;
    onGatewayError?: (err: unknown) => void;
    shouldStopOnError?: (err: unknown) => boolean;
    registerForceStop?: (forceStop: (err: unknown) => void) => void;
};
export declare function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined;
export declare function waitForDiscordGatewayStop(params: WaitForDiscordGatewayStopParams): Promise<void>;
