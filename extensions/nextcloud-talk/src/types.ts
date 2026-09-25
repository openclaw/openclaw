// Nextcloud Talk type declarations define plugin contracts.
import type { MessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { z } from "zod";
import type { OpenClawConfig } from "../runtime-api.js";
import type {
  NextcloudTalkAccountSchemaBase,
  NextcloudTalkConfigSchema,
  NextcloudTalkRoomSchema,
} from "./config-schema.js";

export type NextcloudTalkRoomConfig = NonNullable<z.input<typeof NextcloudTalkRoomSchema>>;
type NextcloudTalkAccountSchemaInput = z.input<typeof NextcloudTalkAccountSchemaBase>;
export type NextcloudTalkAccountConfig = Omit<NextcloudTalkAccountSchemaInput, "rooms"> & {
  rooms?: Record<string, NextcloudTalkRoomConfig>;
};
type NextcloudTalkConfig = Omit<z.input<typeof NextcloudTalkConfigSchema>, "accounts" | "rooms"> & {
  accounts?: Record<string, NextcloudTalkAccountConfig>;
  rooms?: Record<string, NextcloudTalkRoomConfig>;
};

export type CoreConfig = {
  channels?: {
    "nextcloud-talk"?: NextcloudTalkConfig;
  };
  gateway?: OpenClawConfig["gateway"];
  [key: string]: unknown;
};

/**
 * Nextcloud Talk webhook payload types based on Activity Streams 2.0 format.
 * Reference: https://nextcloud-talk.readthedocs.io/en/latest/bots/
 */

/** Actor in the activity (the message sender). */
type NextcloudTalkActor = {
  type: "Person";
  /** User ID in Nextcloud. */
  id: string;
  /** Display name of the user. */
  name: string;
};

/** The message object in the activity. */
type NextcloudTalkObject = {
  type: "Note";
  /** Message ID. */
  id: string;
  /** Message text (same as content for text/plain). */
  name: string;
  /** Message content. */
  content: string;
  /** Media type of the content. */
  mediaType: string;
};

/** Target conversation/room. */
type NextcloudTalkTarget = {
  type: "Collection";
  /** Room token. */
  id: string;
  /** Room display name. */
  name: string;
};

/** Incoming webhook payload from Nextcloud Talk. */
export type NextcloudTalkWebhookPayload = {
  type: "Create" | "Update" | "Delete";
  actor: NextcloudTalkActor;
  object: NextcloudTalkObject;
  target: NextcloudTalkTarget;
};

/** Result from sending a message to Nextcloud Talk. */
export type NextcloudTalkSendResult = {
  messageId: string;
  roomToken: string;
  receipt: MessageReceipt;
  timestamp?: number;
};

/** Parsed incoming message context. */
export type NextcloudTalkInboundMessage = {
  messageId: string;
  roomToken: string;
  roomName: string;
  senderId: string;
  senderName: string;
  text: string;
  mediaType: string;
  timestamp: number;
  isGroupChat: boolean;
};

/** Headers sent by Nextcloud Talk webhook. */
export type NextcloudTalkWebhookHeaders = {
  /** HMAC-SHA256 signature of the request. */
  signature: string;
  /** Random string used in signature calculation. */
  random: string;
  /** Backend Nextcloud server URL. */
  backend: string;
};

/** Options for the webhook server. */
export type NextcloudTalkWebhookServerOptions = {
  port: number;
  host: string;
  path: string;
  secret: string;
  maxBodyBytes?: number;
  authRateLimit?: {
    maxRequests?: number;
    windowMs?: number;
  };
  readBody?: (req: import("node:http").IncomingMessage, maxBodyBytes: number) => Promise<string>;
  isBackendAllowed?: (backend: string) => boolean;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  onWebhook: (rawBody: string) => Promise<"accepted" | "ignored">;
  onError?: (error: Error) => void;
  abortSignal?: AbortSignal;
};
