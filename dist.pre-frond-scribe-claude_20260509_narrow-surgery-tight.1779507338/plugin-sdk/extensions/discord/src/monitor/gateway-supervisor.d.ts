import type { EventEmitter } from "node:events";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
type DiscordGatewayEventType = "disallowed-intents" | "fatal" | "other" | "reconnect-exhausted";
export type DiscordGatewayEvent = {
    type: DiscordGatewayEventType;
    err: unknown;
    message: string;
    shouldStopLifecycle: boolean;
};
export declare class DiscordGatewayLifecycleError extends Error {
    readonly eventType: DiscordGatewayEventType;
    constructor(event: Pick<DiscordGatewayEvent, "type" | "message" | "err">);
}
export declare function getDiscordGatewayEmitter(gateway?: unknown): EventEmitter | undefined;
export type DiscordGatewaySupervisor = {
    emitter?: EventEmitter;
    attachLifecycle: (handler: (event: DiscordGatewayEvent) => void) => void;
    detachLifecycle: () => void;
    drainPending: (handler: (event: DiscordGatewayEvent) => "continue" | "stop") => "continue" | "stop";
    dispose: () => void;
};
export declare function classifyDiscordGatewayEvent(params: {
    err: unknown;
    isDisallowedIntentsError: (err: unknown) => boolean;
}): DiscordGatewayEvent;
export declare function createDiscordGatewaySupervisor(params: {
    gateway?: unknown;
    isDisallowedIntentsError: (err: unknown) => boolean;
    runtime: RuntimeEnv;
}): DiscordGatewaySupervisor;
export {};
