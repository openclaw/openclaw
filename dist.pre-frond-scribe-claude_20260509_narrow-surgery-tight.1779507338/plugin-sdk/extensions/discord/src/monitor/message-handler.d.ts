import type { DiscordMessageHandler } from "./listeners.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import { type DiscordMessageRunQueueTestingHooks } from "./message-run-queue.js";
import type { DiscordMonitorStatusSink } from "./status.js";
type PreflightDiscordMessage = typeof import("./message-handler.preflight.js").preflightDiscordMessage;
type DiscordMessageHandlerParams = Omit<DiscordMessagePreflightParams, "ackReactionScope" | "groupPolicy" | "data" | "client"> & {
    setStatus?: DiscordMonitorStatusSink;
    abortSignal?: AbortSignal;
    testing?: DiscordMessageHandlerTestingHooks;
};
type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
    preflightDiscordMessage?: PreflightDiscordMessage;
};
export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
    deactivate: () => void;
};
export declare function createDiscordMessageHandler(params: DiscordMessageHandlerParams): DiscordMessageHandlerWithLifecycle;
export {};
