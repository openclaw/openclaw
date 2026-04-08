/**
 * Type definitions for the E-Claw channel plugin.
 *
 * E-Claw is an AI chat platform for live wallpaper character entities on
 * Android. Each connected device has a small number of character "slots";
 * an OpenClaw bot claims one slot and exchanges messages with the device
 * owner (and other entities on the same device) via the E-Claw channel API.
 */

type EclawConfigFields = {
  enabled?: boolean;
  apiKey?: string;
  apiBase?: string;
  botName?: string;
  webhookUrl?: string;
};

/** Raw channel config from openclaw.json channels.eclaw */
export interface EclawChannelConfig extends EclawConfigFields {
  accounts?: Record<string, EclawAccountRaw>;
}

/** Raw per-account config (overrides base config) */
export interface EclawAccountRaw extends EclawConfigFields {}

/** Fully resolved account config with defaults applied */
export interface ResolvedEclawAccount {
  accountId: string;
  enabled: boolean;
  apiKey: string;
  apiBase: string;
  botName: string;
  webhookUrl: string;
}

/** Context block injected by the E-Claw server for Channel Bot parity */
export interface EclawContextBlock {
  b2bRemaining?: number;
  b2bMax?: number;
  expectsReply?: boolean;
  missionHints?: string;
  silentToken?: string;
}

/** Inbound message payload from the E-Claw callback webhook */
export interface EclawInboundMessage {
  event: "message" | "entity_message" | "broadcast" | "cross_device_message";
  deviceId: string;
  entityId: number;
  conversationId?: string;
  from: string;
  text: string;
  mediaType?: "photo" | "voice" | "video" | "file" | null;
  mediaUrl?: string | null;
  backupUrl?: string | null;
  timestamp?: number;
  isBroadcast?: boolean;
  broadcastRecipients?: number[] | null;
  fromEntityId?: number;
  fromCharacter?: string;
  fromPublicCode?: string;
  eclaw_context?: EclawContextBlock;
}

/** Entity slot info returned by POST /api/channel/register */
export interface EclawEntityInfo {
  entityId: number;
  isBound: boolean;
  name: string | null;
  character: string;
  bindingType: string | null;
}

/** Response from POST /api/channel/register */
export interface EclawRegisterResponse {
  success: boolean;
  deviceId: string;
  entities: EclawEntityInfo[];
  maxEntities: number;
  message?: string;
}

/** Response from POST /api/channel/bind */
export interface EclawBindResponse {
  success: boolean;
  deviceId: string;
  entityId: number;
  botSecret: string;
  publicCode: string;
  bindingType: string;
  message?: string;
  entities?: EclawEntityInfo[];
}

/** Response from POST /api/channel/message */
export interface EclawMessageResponse {
  success: boolean;
  message?: string;
  currentState?: {
    name: string;
    state: string;
    message: string;
    xp: number;
    level: number;
  };
}
