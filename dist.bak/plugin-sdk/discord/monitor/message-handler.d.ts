import type { DiscordMessageHandler } from "./listeners.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
type DiscordMessageHandlerParams = Omit<DiscordMessagePreflightParams, "ackReactionScope" | "groupPolicy" | "data" | "client">;
export declare function createDiscordMessageHandler(params: DiscordMessageHandlerParams): DiscordMessageHandler;
export {};
