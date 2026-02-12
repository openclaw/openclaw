/**
 * DingTalk message types for the stream client.
 */

/**
 * Raw stream message envelope (varies across DingTalk versions)
 * This is used by message-parser.ts to extract chatbot messages.
 */
export interface RawStreamMessage {
  type?: string;
  eventType?: string;
  event_type?: string;
  headers?: RawHeaders;
  header?: RawHeaders;
  meta?: RawHeaders;
  data?: unknown;
  payload?: unknown;
  body?: unknown;
  event?: unknown;
  content?: unknown;
  messageId?: string;
  message_id?: string;
  id?: string;
  uuid?: string;
}

export interface RawHeaders {
  eventType?: string;
  event_type?: string;
  type?: string;
  topic?: string;
  messageId?: string;
  message_id?: string;
  contentType?: string;
}

/**
 * @提及用户信息
 */
export interface AtUser {
  dingtalkId: string;
  staffId?: string;
}

/**
 * Parsed chatbot message with normalized fields.
 */
export interface ChatbotMessage {
  messageId: string;
  eventType: string;
  text: string;
  sessionWebhook: string;
  conversationId: string;
  chatType: string;
  senderId: string;
  senderName: string;
  raw: RawStreamMessage;

  // @提及相关字段
  atUsers: AtUser[];
  isInAtList: boolean;

  // 文件消息相关字段
  downloadCode?: string;
  fileName?: string;
  fileType?: string;

  // 图片消息相关字段
  picUrl?: string;
}

/**
 * Stream client handle for stopping the connection.
 */
export interface StreamClientHandle {
  stop: () => void;
}

/**
 * Options for starting the stream client.
 * Note: apiBase, openPath, and openBody are no longer used as the SDK handles these internally.
 */
export interface StreamClientOptions {
  clientId: string;
  clientSecret: string;
  /** @deprecated No longer used - SDK handles API base internally */
  apiBase?: string;
  /** @deprecated No longer used - SDK handles open path internally */
  openPath?: string;
  /** @deprecated No longer used - SDK handles subscriptions internally */
  openBody?: Record<string, unknown>;
  logger?: StreamLogger;
  onChatMessage: (message: ChatbotMessage) => Promise<void>;
}

/**
 * Logger interface for stream client.
 */
export interface StreamLogger {
  debug?: (obj: Record<string, unknown>, msg?: string) => void;
  info?: (obj: Record<string, unknown> | string, msg?: string) => void;
  warn?: (obj: Record<string, unknown> | string, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
}
