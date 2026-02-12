/** Nova channel configuration stored under `channels.nova`. */
export type NovaConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  userId?: string;
  deviceId?: string;
  dmPolicy?: string;
  allowFrom?: Array<string | number>;
  reconnectBaseDelayMs?: number;
  heartbeatIntervalMs?: number;
};

/** Fully resolved credentials (all required fields present). */
export type NovaCredentials = {
  baseUrl: string;
  apiKey: string;
  userId: string;
  deviceId: string;
};

/** Inbound message pushed to OpenClaw via WebSocket. */
export type NovaInboundMessage = {
  action: "message";
  userId: string;
  text: string;
  messageId: string;
  timestamp: number;
};

/** Outbound response frame sent by OpenClaw via WebSocket. */
export type NovaOutboundFrame = {
  action: "response";
  type: "chunk" | "done";
  text: string;
  messageId: string;
  replyTo: string;
};

/** Heartbeat frame sent periodically to keep the WebSocket connection alive. */
export type NovaHeartbeatFrame = {
  action: "ping";
  timestamp: number;
};

/** Any frame OpenClaw sends over the WebSocket. */
export type NovaOutgoingFrame = NovaOutboundFrame | NovaHeartbeatFrame;
