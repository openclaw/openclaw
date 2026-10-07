import {
  GatewayDispatchEvents,
  type APIInteraction,
  type APIMessage,
  type APIReaction,
  type APIUnavailableGuild,
  type APIVoiceState,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayPresenceUpdateDispatchData,
  type GatewayThreadDeleteDispatchData,
  type GatewayThreadUpdateDispatchData,
} from "discord-api-types/v10";
import type { Client } from "./client.js";
import { Guild, Message, User } from "./structures.js";

export type DiscordMessageDispatchData = {
  id?: string;
  channel_id: string;
  channelId?: string;
  guild_id?: string;
  message: Message;
  author: User | null;
  member?: { roles?: string[]; nick?: string | null; nickname?: string | null };
  rawMember?: { roles?: string[]; nick?: string | null; nickname?: string | null };
  guild?: Guild | null;
  channel?: unknown;
};

type DiscordReactionDispatchData = {
  user_id?: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  emoji: APIReaction["emoji"];
  burst?: boolean;
  type?: number;
  user: User;
  rawMember?: { roles?: string[] };
  guild?: Guild | null;
  message: Message<true> | { fetch(): Promise<{ author?: User | null }> };
  rawMessage?: APIMessage;
};

abstract class BaseListener<Data = unknown> {
  abstract readonly type: string;
  abstract handle(data: Data, client: Client): Promise<void> | void;
}

export abstract class ReadyListener extends BaseListener {
  readonly type = GatewayDispatchEvents.Ready;
}

export abstract class GuildCreateListener extends BaseListener<
  GatewayGuildCreateDispatchData | APIUnavailableGuild
> {
  readonly type = GatewayDispatchEvents.GuildCreate;
}

export abstract class GuildDeleteListener extends BaseListener<GatewayGuildDeleteDispatchData> {
  readonly type = GatewayDispatchEvents.GuildDelete;
}

export abstract class MessageCreateListener extends BaseListener<APIMessage> {
  readonly type = GatewayDispatchEvents.MessageCreate;
}

export abstract class InteractionCreateListener extends BaseListener<APIInteraction> {
  readonly type = GatewayDispatchEvents.InteractionCreate;
}

export abstract class MessageReactionAddListener extends BaseListener<DiscordReactionDispatchData> {
  readonly type = GatewayDispatchEvents.MessageReactionAdd;
}

export abstract class MessageReactionRemoveListener extends BaseListener<DiscordReactionDispatchData> {
  readonly type = GatewayDispatchEvents.MessageReactionRemove;
}

export abstract class PresenceUpdateListener extends BaseListener<GatewayPresenceUpdateDispatchData> {
  readonly type = GatewayDispatchEvents.PresenceUpdate;
}

export abstract class VoiceStateUpdateListener extends BaseListener<APIVoiceState> {
  readonly type = GatewayDispatchEvents.VoiceStateUpdate;
}

export abstract class ThreadUpdateListener extends BaseListener<GatewayThreadUpdateDispatchData> {
  readonly type = GatewayDispatchEvents.ThreadUpdate;
}

export abstract class ThreadDeleteListener extends BaseListener<GatewayThreadDeleteDispatchData> {
  readonly type = GatewayDispatchEvents.ThreadDelete;
}
