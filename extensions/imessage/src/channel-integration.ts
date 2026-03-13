/**
 * Integration layer for enhanced iMessage reply processing
 * 
 * This module patches the existing OpenClaw iMessage channel to add reply context support.
 * It integrates seamlessly with the existing message processing pipeline.
 */

import type { 
  ChannelPlugin, 
  ResolvedIMessageAccount,
  PluginRuntime 
} from "openclaw/plugin-sdk";
import { 
  createIMessageReplyProcessor,
  IMessageReplyProcessor,
  REPLY_TEXT_MAX_LENGTH,
  type IMessageMessage,
  type EnhancedIMessageMessage 
} from "./message-processor.js";

/**
 * Enhanced inbound context type that includes reply information
 */
export interface EnhancedInboundContext {
  // Standard OpenClaw inbound context fields
  chat_id: string;
  provider: string;
  surface: string;
  chat_type: "direct" | "group";
  sender?: {
    id: string;
    name?: string;
  };
  message: {
    id: string;
    text: string;
    timestamp: string;
  };
  
  // Enhanced reply context
  reply_context?: {
    original_message_id: string;
    original_text: string;
    original_sender: string;
    original_timestamp: string;
    is_original_from_assistant: boolean;
  };
}

/**
 * Enhanced iMessage message processor that integrates with OpenClaw
 */
export class OpenClawIMessageEnhancer {
  private replyProcessor: IMessageReplyProcessor;
  private runtime: PluginRuntime;

  constructor(runtime: PluginRuntime) {
    this.runtime = runtime;
    this.replyProcessor = createIMessageReplyProcessor(runtime);
  }

  /**
   * Process an inbound iMessage and prepare it for OpenClaw's agent system
   */
  async processInboundMessage(
    rawMessage: IMessageMessage,
    chatType: "direct" | "group" = "direct"
  ): Promise<EnhancedInboundContext> {
    // Step 1: Enhance the message with reply context
    const enhancedMessage = await this.replyProcessor.processMessage(rawMessage);

    // Step 2: Build the standard inbound context
    const baseContext = this.buildBaseInboundContext(enhancedMessage, chatType);

    // Step 3: Add reply context if present
    if (enhancedMessage.reply_to) {
      baseContext.reply_context = {
        original_message_id: enhancedMessage.reply_to.message_id,
        original_text: enhancedMessage.reply_to.text,
        original_sender: enhancedMessage.reply_to.sender,
        original_timestamp: enhancedMessage.reply_to.created_at,
        // Note: This is a heuristic. is_from_me indicates the message was sent from this
        // device, but doesn't guarantee it was from the AI assistant. In scenarios where
        // a human also sends messages from the same device, this may be inaccurate.
        // Future improvement: Track assistant message GUIDs in a registry for precise detection.
        is_original_from_assistant: enhancedMessage.reply_to.is_from_me,
      };
    }

    return baseContext;
  }

  /**
   * Build the base inbound context structure expected by OpenClaw
   */
  private buildBaseInboundContext(
    message: EnhancedIMessageMessage,
    chatType: "direct" | "group"
  ): EnhancedInboundContext {
    return {
      chat_id: `imessage:${message.sender}`,
      provider: "imessage", 
      surface: "imessage",
      chat_type: chatType,
      sender: {
        id: message.sender,
        name: message.destination_caller_id || undefined,
      },
      message: {
        id: message.guid,
        text: message.text,
        timestamp: message.created_at,
      },
    };
  }

  /**
   * Format the inbound context for the AI with reply information
   */
  formatContextForAI(context: EnhancedInboundContext): string {
    let formatted = context.message.text;

    if (context.reply_context) {
      const originalSender = context.reply_context.is_original_from_assistant 
        ? "Assistant" 
        : (context.reply_context.original_sender || "User");
        
      const originalTime = new Date(context.reply_context.original_timestamp).toLocaleString();
      
      // Truncate long messages for better readability
      const originalText = context.reply_context.original_text.length > REPLY_TEXT_MAX_LENGTH
        ? context.reply_context.original_text.substring(0, REPLY_TEXT_MAX_LENGTH) + "..."
        : context.reply_context.original_text;

      formatted = `[Reply to ${originalSender} (${originalTime})]: "${originalText}"

${context.message.text}`;
    }

    return formatted;
  }

  /**
   * Generate trusted metadata JSON for OpenClaw inbound context
   */
  generateTrustedMetadata(context: EnhancedInboundContext): object {
    const metadata: any = {
      schema: "openclaw.inbound_meta.v1",
      chat_id: context.chat_id,
      channel: "imessage",
      provider: "imessage", 
      surface: "imessage",
      chat_type: context.chat_type,
    };

    // Add reply metadata if present
    if (context.reply_context) {
      metadata.reply_to = {
        message_id: context.reply_context.original_message_id,
        sender: context.reply_context.original_sender,
        timestamp: context.reply_context.original_timestamp,
        is_from_assistant: context.reply_context.is_original_from_assistant,
      };
    }

    return metadata;
  }
}

/**
 * Integration utility for adding reply context processing to iMessage messages
 * 
 * This provides a practical way to enhance iMessage messages with reply context
 * that can be integrated into OpenClaw's existing message processing pipeline.
 * 
 * Usage pattern:
 * 1. In the message monitoring code, when an inbound message is received
 * 2. Call processIMessageWithReplyContext() to enhance it
 * 3. Pass the enhanced context to the AI instead of the raw message
 */
export async function processIMessageWithReplyContext(
  runtime: PluginRuntime,
  rawMessage: IMessageMessage,
  chatType: "direct" | "group" = "direct"
): Promise<EnhancedInboundContext> {
  const enhancer = new OpenClawIMessageEnhancer(runtime);
  return enhancer.processInboundMessage(rawMessage, chatType);
}

/**
 * DEPRECATED: This function was incomplete and has been removed.
 * Use processIMessageWithReplyContext() instead for practical integration.
 * 
 * The proper integration should be done at the message monitoring level where
 * inbound messages are processed before being sent to the AI system.
 */

/**
 * Factory function to create an enhanced iMessage processor
 */
export function createEnhancedIMessageProcessor(runtime: PluginRuntime): OpenClawIMessageEnhancer {
  return new OpenClawIMessageEnhancer(runtime);
}