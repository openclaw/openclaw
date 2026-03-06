import type { DiscordMessageHandler } from "./listeners.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
type DiscordMessageHandlerParams = Omit<DiscordMessagePreflightParams, "ackReactionScope" | "groupPolicy" | "data" | "client"> & {
    setStatus?: DiscordMonitorStatusSink;
    abortSignal?: AbortSignal;
    listenerTimeoutMs?: number;
};
export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
    deactivate: () => void;
};
export declare function createDiscordMessageHandler(params: DiscordMessageHandlerParams): DiscordMessageHandlerWithLifecycle;
export {};
