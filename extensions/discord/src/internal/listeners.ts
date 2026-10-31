import {
  GatewayDispatchEvents,
  type APIInteraction,
  type APIMessage,
  type APIReaction,
  type APIUnavailableGuild,
  type APIVoiceState,
  type GatewayGuildCreateDispatchData,
  type GatewayGuildDeleteDispatchData,
  type GatewayMessageCreateDispatchData,
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

export type ListenerDataByEvent = {
  [GatewayDispatchEvents.Ready]: unknown;
  [GatewayDispatchEvents.GuildCreate]: GatewayGuildCreateDispatchData | APIUnavailableGuild;
  [GatewayDispatchEvents.GuildDelete]: GatewayGuildDeleteDispatchData;
  [GatewayDispatchEvents.MessageCreate]: GatewayMessageCreateDispatchData;
  [GatewayDispatchEvents.InteractionCreate]: APIInteraction;
  [GatewayDispatchEvents.MessageReactionAdd]: DiscordReactionDispatchData;
  [GatewayDispatchEvents.MessageReactionRemove]: DiscordReactionDispatchData;
  [GatewayDispatchEvents.PresenceUpdate]: GatewayPresenceUpdateDispatchData;
  [GatewayDispatchEvents.VoiceStateUpdate]: APIVoiceState;
  [GatewayDispatchEvents.ThreadUpdate]: GatewayThreadUpdateDispatchData;
  [GatewayDispatchEvents.ThreadDelete]: GatewayThreadDeleteDispatchData;
};

abstract class BaseListener<Event extends keyof ListenerDataByEvent> {
  abstract readonly type: Event;
  abstract handle(data: ListenerDataByEvent[Event], client: Client): Promise<void> | void;
}

export abstract class ReadyListener extends BaseListener<GatewayDispatchEvents.Ready> {
  readonly type = GatewayDispatchEvents.Ready;
}

export abstract class GuildCreateListener extends BaseListener<GatewayDispatchEvents.GuildCreate> {
  readonly type = GatewayDispatchEvents.GuildCreate;
}
