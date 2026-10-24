import type { EventEmitter } from "node:events";
import type {
  DiscordGatewayAdapterCreator,
  DiscordGatewayAdapterLibraryMethods,
} from "@discordjs/voice";
import type {
  APIVoiceState,
  GatewayPresenceUpdateData,
  GatewayReceivePayload,
  GatewaySendPayload,
  GatewayVoiceStateUpdateData,
} from "discord-api-types/v10";
import type { WebSocket } from "ws";
import type { DiscordGatewayChannelInfo } from "./gateway-channel-inventory.js";

export type Activity = NonNullable<GatewayPresenceUpdateData["activities"]>[number];
export type UpdatePresenceData = Omit<GatewayPresenceUpdateData, "status"> & {
  status: "online" | "idle" | "dnd" | "invisible" | "offline";
};

export type GatewayPluginOptions = {
  intents?: number;
  url?: string;
};

export type DiscordGatewayVoiceStateTransition = {
  current: APIVoiceState;
  previous?: APIVoiceState;
};

export interface GatewayPluginContract {
  readonly id: "gateway";
  readonly options: GatewayPluginOptions;
  emitter: EventEmitter;
  isConnected: boolean;
  sequence: number | null;
  ws: WebSocket | null;
  connect(resume?: boolean): void;
  disconnect(): void;
  send(payload: GatewaySendPayload | GatewayReceivePayload, skipRateLimit?: boolean): void;
  updatePresence(data: UpdatePresenceData): void;
  updateVoiceState(data: GatewayVoiceStateUpdateData): void;
  fetchGuildEmojis<T>(guildId: string, fetcher: () => Promise<T>): Promise<T>;
  listVoiceChannelStates(guildId: string, channelId: string): APIVoiceState[] | null;
  takeVoiceStateTransition(state: APIVoiceState): DiscordGatewayVoiceStateTransition | null;
  // Required: an optional hydration probe would let a caller's "cannot answer
  // yet" fallback hold a gateway's backlog forever.
  getGatewayChannelInfo(channelId: string): DiscordGatewayChannelInfo | undefined;
  isGatewayChannelInventoryHydrating(guildId: string): boolean;
}

export interface VoicePluginContract {
  readonly id: "voice";
  readonly adapters: Map<string, DiscordGatewayAdapterLibraryMethods>;
  getGateway(guildId: string): GatewayPluginContract | undefined;
  getGatewayAdapterCreator(guildId: string): DiscordGatewayAdapterCreator;
}
