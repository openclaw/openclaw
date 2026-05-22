import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type Client, InteractionCreateListener, MessageCreateListener, PresenceUpdateListener, ThreadUpdateListener } from "../internal/discord.js";
export { DiscordReactionListener, DiscordReactionRemoveListener } from "./listeners.reactions.js";
type Logger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;
export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordInteractionEvent = Parameters<InteractionCreateListener["handle"]>[0];
export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client, options?: {
    abortSignal?: AbortSignal;
}) => Promise<void>;
export declare function registerDiscordListener(listeners: Array<object>, listener: object): boolean;
export declare class DiscordMessageListener extends MessageCreateListener {
    private handler;
    private logger?;
    private onEvent?;
    constructor(handler: DiscordMessageHandler, logger?: Logger | undefined, onEvent?: (() => void) | undefined);
    handle(data: DiscordMessageEvent, client: Client): Promise<void>;
}
export declare class DiscordInteractionListener extends InteractionCreateListener {
    private logger?;
    private onEvent?;
    constructor(logger?: Logger | undefined, onEvent?: (() => void) | undefined);
    handle(data: DiscordInteractionEvent, client: Client): Promise<void>;
}
type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];
export declare class DiscordPresenceListener extends PresenceUpdateListener {
    private logger?;
    private accountId?;
    constructor(params: {
        logger?: Logger;
        accountId?: string;
    });
    handle(data: PresenceUpdateEvent): Promise<void>;
}
type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];
export declare class DiscordThreadUpdateListener extends ThreadUpdateListener {
    private cfg;
    private accountId;
    private logger?;
    constructor(cfg: OpenClawConfig, accountId: string, logger?: Logger | undefined);
    handle(data: ThreadUpdateEvent): Promise<void>;
}
