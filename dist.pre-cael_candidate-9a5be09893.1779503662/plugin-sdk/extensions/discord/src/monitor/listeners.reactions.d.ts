import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { type Client, MessageReactionAddListener, MessageReactionRemoveListener } from "../internal/discord.js";
import { type DiscordListenerLogger } from "./listeners.queue.js";
type LoadedConfig = OpenClawConfig;
type RuntimeEnv = import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];
type DiscordReactionListenerParams = {
    cfg: LoadedConfig;
    runtime: RuntimeEnv;
    logger: DiscordListenerLogger;
    onEvent?: () => void;
} & DiscordReactionRoutingParams;
type DiscordReactionRoutingParams = {
    accountId: string;
    botUserId?: string;
    dmEnabled: boolean;
    groupDmEnabled: boolean;
    groupDmChannels: string[];
    dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
    allowFrom: string[];
    groupPolicy: "open" | "allowlist" | "disabled";
    allowNameMatching: boolean;
    guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
};
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
export {};
