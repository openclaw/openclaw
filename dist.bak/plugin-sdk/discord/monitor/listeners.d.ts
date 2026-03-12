import { type Client, MessageCreateListener, MessageReactionAddListener, MessageReactionRemoveListener, PresenceUpdateListener } from "@buape/carbon";
type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;
export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];
export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client) => Promise<void>;
type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];
type DiscordReactionListenerParams = {
    cfg: LoadedConfig;
    accountId: string;
    runtime: RuntimeEnv;
    botUserId?: string;
    dmEnabled: boolean;
    groupDmEnabled: boolean;
    groupDmChannels: string[];
    dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
    allowFrom: string[];
    groupPolicy: "open" | "allowlist" | "disabled";
    allowNameMatching: boolean;
    guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
    logger: Logger;
};
export declare function registerDiscordListener(listeners: Array<object>, listener: object): boolean;
export declare class DiscordMessageListener extends MessageCreateListener {
    private handler;
    private logger?;
    constructor(handler: DiscordMessageHandler, logger?: Logger | undefined);
    handle(data: DiscordMessageEvent, client: Client): Promise<void>;
}
export declare class DiscordReactionListener extends MessageReactionAddListener {
    private params;
    constructor(params: DiscordReactionListenerParams);
    handle(data: DiscordReactionEvent, client: Client): Promise<void>;
}
export declare class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
    private params;
    constructor(params: DiscordReactionListenerParams);
    handle(data: DiscordReactionEvent, client: Client): Promise<void>;
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
export {};
