import type { EventEmitter } from "node:events";
export type DiscordGatewayHandle = {
    emitter?: Pick<EventEmitter, "on" | "removeListener">;
    disconnect?: () => void;
};
export declare function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined;
export declare function waitForDiscordGatewayStop(params: {
    gateway?: DiscordGatewayHandle;
    abortSignal?: AbortSignal;
    onGatewayError?: (err: unknown) => void;
    shouldStopOnError?: (err: unknown) => boolean;
}): Promise<void>;
