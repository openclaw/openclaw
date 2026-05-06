/**
 * Gateway endpoint model
 */
export class GatewayEndpoint {
  stableId: string = '';
  name: string = '';
  host: string = '';
  port: number = 0;
  tlsEnabled: boolean = false;
}

/**
 * Gateway authentication response
 */
export interface GatewayAuthResponse {
  serverName: string;
  mainSessionKey: string;
  protocolVersion?: string;
  serverAddress?: string;
}

/**
 * Chat message content block
 */
export class ChatMessageContent {
  type: string = 'text';
  text: string = '';
}

/**
 * Chat message
 */
export class ChatMessage {
  stableKey: string = '';
  role: string = '';
  content: ChatMessageContent[] = [];
}

/**
 * Chat session entry
 */
export class ChatSessionEntry {
  key: string = '';
  displayName: string = '';
  updatedAtMs: number = 0;
}

/**
 * Chat pending tool call
 */
export class ChatPendingToolCall {
  id: string = '';
  name: string = '';
  paramsJson: string = '';
}

/**
 * Outgoing attachment
 */
export class OutgoingAttachment {
  type: string = '';
  data: string = '';
}

/**
 * Voice conversation entry
 */
export class VoiceConversationEntry {
  role: string = '';
  text: string = '';
}

/**
 * Gateway protocol version constant
 */
export const GATEWAY_PROTOCOL_VERSION = 3;
