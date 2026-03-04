/**
 * Enhanced iMessage Message Processor
 * 
 * Adds reply context support to OpenClaw iMessage integration by detecting
 * thread_originator_guid fields and fetching the original message content.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";

/**
 * Configuration constants
 */
export const REPLY_TEXT_MAX_LENGTH = 200;

export interface IMessageMessage {
  id: number;
  guid: string;
  chat_id: number;
  sender: string;
  text: string;
  is_from_me: boolean;
  created_at: string;
  thread_originator_guid?: string;
  destination_caller_id?: string;
  attachments?: any[];
  reactions?: any[];
}

export interface IMessageReplyContext {
  message_id: string;
  text: string;
  sender: string;
  created_at: string;
  is_from_me: boolean;
}

export interface EnhancedIMessageMessage extends IMessageMessage {
  reply_to?: IMessageReplyContext;
}

export class IMessageReplyProcessor {
  private runtime: PluginRuntime;

  constructor(runtime: PluginRuntime) {
    this.runtime = runtime;
  }

  /**
   * Process an inbound iMessage message and enrich it with reply context if present
   */
  async processMessage(rawMessage: IMessageMessage): Promise<EnhancedIMessageMessage> {
    // Check if this message is a reply to another message
    if (!rawMessage.thread_originator_guid) {
      // Not a reply - return as-is
      return rawMessage;
    }

    try {
      // Fetch the original message being replied to
      const originalMessage = await this.fetchMessageByGuid(
        rawMessage.thread_originator_guid,
        rawMessage.chat_id
      );

      if (!originalMessage) {
        // Original message not found - log warning but don't fail
        console.warn(
          `[iMessage Reply] Could not find original message with GUID: ${rawMessage.thread_originator_guid}`
        );
        return rawMessage;
      }

      // Enrich the message with reply context
      return {
        ...rawMessage,
        reply_to: {
          message_id: originalMessage.guid,
          text: originalMessage.text,
          sender: originalMessage.sender,
          created_at: originalMessage.created_at,
          is_from_me: originalMessage.is_from_me,
        },
      };
    } catch (error) {
      // Log error but don't fail message processing
      console.error("[iMessage Reply] Error fetching original message:", error);
      return rawMessage;
    }
  }

  /**
   * Fetch a message by its GUID from the specified chat
   */
  private async fetchMessageByGuid(
    guid: string,
    chatId: number
  ): Promise<IMessageMessage | null> {
    try {
      // Validate chatId to prevent shell command injection
      const safeChatId = parseInt(String(chatId), 10);
      if (!Number.isFinite(safeChatId) || safeChatId < 0) {
        throw new Error(`Invalid chatId: ${chatId}`);
      }

      // Use imsg CLI to query the message history and find the specific GUID
      const result = await this.runtime.shell.exec(
        `imsg history --chat-id ${safeChatId} --limit 100 --json`,
        {
          encoding: "utf8",
          timeout: 10000, // 10 second timeout
        }
      );

      if (result.exitCode !== 0) {
        throw new Error(`imsg command failed with exit code ${result.exitCode}: ${result.stderr}`);
      }

      // Parse the JSON output - each line is a separate message
      const lines = result.stdout.trim().split("\n");
      
      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const message: IMessageMessage = JSON.parse(line);
          if (message.guid === guid) {
            return message;
          }
        } catch (parseError) {
          console.warn("[iMessage Reply] Failed to parse message line:", line, parseError);
        }
      }

      // Message not found in recent history - try extended search with pagination
      // Skip messages we already checked by using offset or larger initial limit
      const extendedResult = await this.runtime.shell.exec(
        `imsg history --chat-id ${safeChatId} --limit 500 --json`,
        {
          encoding: "utf8",
          timeout: 30000, // 30 second timeout for extended search
        }
      );

      if (extendedResult.exitCode === 0) {
        const extendedLines = extendedResult.stdout.trim().split("\n");
        
        // Skip the first 100 messages we already processed to avoid redundant work
        const newMessages = extendedLines.slice(100);
        
        for (const line of newMessages) {
          if (!line.trim()) continue;
          
          try {
            const message: IMessageMessage = JSON.parse(line);
            if (message.guid === guid) {
              return message;
            }
          } catch (parseError) {
            // Ignore parse errors in extended search
          }
        }
      }

      return null;
    } catch (error) {
      console.error("[iMessage Reply] Error executing imsg command:", error);
      return null;
    }
  }

  /**
   * Create a human-readable context summary for the AI
   */
  static formatReplyContext(message: EnhancedIMessageMessage): string {
    if (!message.reply_to) {
      return "";
    }

    const originalSender = message.reply_to.is_from_me ? "You" : message.reply_to.sender;
    const originalTime = new Date(message.reply_to.created_at).toLocaleString();
    const originalText = message.reply_to.text.length > REPLY_TEXT_MAX_LENGTH 
      ? message.reply_to.text.substring(0, REPLY_TEXT_MAX_LENGTH) + "..."
      : message.reply_to.text;

    return `[Replying to message from ${originalSender} at ${originalTime}]: "${originalText}"`;
  }

  /**
   * Check if a message is a reply
   */
  static isReply(message: IMessageMessage | EnhancedIMessageMessage): boolean {
    return Boolean(message.thread_originator_guid);
  }

  /**
   * Extract reply metadata for analytics/logging
   */
  static getReplyMetadata(message: EnhancedIMessageMessage) {
    if (!message.reply_to) {
      return null;
    }

    return {
      original_message_id: message.reply_to.message_id,
      original_sender: message.reply_to.sender,
      original_timestamp: message.reply_to.created_at,
      reply_delay_ms: new Date(message.created_at).getTime() - 
                      new Date(message.reply_to.created_at).getTime(),
      has_context: Boolean(message.reply_to.text),
    };
  }
}

/**
 * Factory function to create a reply processor instance
 */
export function createIMessageReplyProcessor(runtime: PluginRuntime): IMessageReplyProcessor {
  return new IMessageReplyProcessor(runtime);
}

/**
 * Utility function for quick processing of a single message
 */
export async function processIMessageWithReplyContext(
  runtime: PluginRuntime,
  rawMessage: IMessageMessage
): Promise<EnhancedIMessageMessage> {
  const processor = createIMessageReplyProcessor(runtime);
  return processor.processMessage(rawMessage);
}