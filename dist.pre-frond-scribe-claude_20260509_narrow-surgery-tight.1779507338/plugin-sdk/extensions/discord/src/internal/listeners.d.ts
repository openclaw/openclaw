import { GatewayDispatchEvents, type APIMessage, type APIReaction, type APIVoiceState, type GatewayPresenceUpdateDispatchData, type GatewayThreadUpdateDispatchData } from "discord-api-types/v10";
import type { Client } from "./client.js";
import { Guild, Message, User } from "./structures.js";
export type DiscordMessageDispatchData = {
    id?: string;
    channel_id: string;
    channelId?: string;
    guild_id?: string;
    message: Message;
    author: User | null;
    member?: {
        roles?: string[];
        nick?: string | null;
        nickname?: string | null;
    };
    rawMember?: {
        roles?: string[];
        nick?: string | null;
        nickname?: string | null;
    };
    guild?: Guild | null;
    channel?: unknown;
};
export type DiscordReactionDispatchData = {
    user_id?: string;
    channel_id: string;
    message_id: string;
    guild_id?: string;
    emoji: APIReaction["emoji"];
    burst?: boolean;
    type?: number;
    user: User;
    rawMember?: {
        roles?: string[];
    };
    guild?: Guild | null;
    message: Message<true> | {
        fetch(): Promise<{
            author?: User | null;
        }>;
    };
    rawMessage?: APIMessage;
};
export declare abstract class BaseListener {
    abstract readonly type: string;
    abstract handle(data: unknown, client: Client): Promise<void> | void;
}
export declare abstract class ReadyListener extends BaseListener {
    readonly type = GatewayDispatchEvents.Ready;
}
export declare abstract class ResumedListener extends BaseListener {
    readonly type = GatewayDispatchEvents.Resumed;
}
export declare abstract class MessageCreateListener extends BaseListener {
    readonly type = GatewayDispatchEvents.MessageCreate;
    abstract handle(data: DiscordMessageDispatchData, client: Client): Promise<void> | void;
}
export declare abstract class InteractionCreateListener extends BaseListener {
    readonly type = GatewayDispatchEvents.InteractionCreate;
}
export declare abstract class MessageReactionAddListener extends BaseListener {
    readonly type = GatewayDispatchEvents.MessageReactionAdd;
    abstract handle(data: DiscordReactionDispatchData, client: Client): Promise<void> | void;
}
export declare abstract class MessageReactionRemoveListener extends BaseListener {
    readonly type = GatewayDispatchEvents.MessageReactionRemove;
    abstract handle(data: DiscordReactionDispatchData, client: Client): Promise<void> | void;
}
export declare abstract class PresenceUpdateListener extends BaseListener {
    readonly type = GatewayDispatchEvents.PresenceUpdate;
    abstract handle(data: GatewayPresenceUpdateDispatchData, client: Client): Promise<void> | void;
}
export declare abstract class VoiceStateUpdateListener extends BaseListener {
    readonly type = GatewayDispatchEvents.VoiceStateUpdate;
    abstract handle(data: APIVoiceState, client: Client): Promise<void> | void;
}
export declare abstract class ThreadUpdateListener extends BaseListener {
    readonly type = GatewayDispatchEvents.ThreadUpdate;
    abstract handle(data: GatewayThreadUpdateDispatchData, client: Client): Promise<void> | void;
}
