/**
 * Plugin hook types - simplified local definitions to avoid depending on OpenClaw internals
 */

export interface PluginHookMessageReceivedEvent {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface PluginHookMessageReceivedResult {
  suppress?: boolean;
  content?: string; // If set, replaces message content before agent processing
}

export interface PluginHookMessageSendingEvent {
  to: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface PluginHookMessageSendingResult {
  content?: string;
  cancel?: boolean;
}

export interface PluginHookMessageSentEvent {
  to: string;
  content: string;
  success: boolean;
  error?: string;
}

export interface PluginHookMessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
}
