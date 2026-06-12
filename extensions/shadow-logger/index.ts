import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { registerInternalHook, type InternalHookEvent, isMessageReceivedEvent, isMessageSentEvent } from "../../../src/hooks/internal-hooks.js";
import type { PluginRuntime } from "../../../src/plugins/runtime/types.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import { createSupabaseClient } from "./supabase-client.js";

/**
 * ShadowLoggerPlugin
 * 
 * Captures inbound and outbound messages via internal hooks and 
 * persists them to Supabase for long-term memory distillation.
 * 
 * See ./README.md for the full technical specification.
 */
export class ShadowLoggerPlugin {
  private logger: PluginLogger;
  private supabase: ReturnType<typeof createSupabaseClient> | undefined;

  constructor(logger: PluginLogger) {
    this.logger = logger;
  }

  public async onStart(runtime: PluginRuntime): Promise<void> {
    this.logger.info("Shadow Logger Plugin starting...");

    try {
      this.supabase = createSupabaseClient();
      this.logger.info("Shadow Logger: Supabase client initialized.");
    } catch (err) {
      this.logger.error(`Shadow Logger: Failed to initialize Supabase client: ${err}`);
      return;
    }

    // Register message:received hook
    registerInternalHook("message:received", async (event: InternalHookEvent) => {
      if (isMessageReceivedEvent(event)) {
        await this.logToSupabase(event);
      }
    });

    // Register message:sent hook
    registerInternalHook("message:sent", async (event: InternalHookEvent) => {
      if (isMessageSentEvent(event)) {
        await this.logToSupabase(event);
      }
    });

    this.logger.info("Shadow Logger: Hooks registered successfully.");
  }

  private async logToSupabase(event: InternalHookEvent): Promise<void> {
    if (!this.supabase) {
      this.logger.warn("Shadow Logger: Attempted to log message but Supabase client is not initialized.");
      return;
    }

    try {
      const payload = this.extractPayload(event);
      const { error } = await this.supabase.from("dialogues").insert(payload);

      if (error) {
        this.logger.error(`Shadow Logger: Supabase insert error [${event.type}:${event.action}]: ${error.message}`);
      } else {
        this.logger.debug(`Shadow Logger: Successfully logged ${event.type}:${event.action} to Supabase.`);
      }
    } catch (err) {
      this.logger.error(`Shadow Logger: Unexpected error during Supabase logging: ${err}`);
    }
  }

  private extractPayload(event: InternalHookEvent): Record<string, unknown> {
    const context = event.context as Record<string, unknown>;
    const basePayload: Record<string, unknown> = {
      session_id: event.sessionKey,
      timestamp: event.timestamp || new Date().toISOString(),
      metadata: context,
    };

    if (isMessageReceivedEvent(event)) {
      return {
        ...basePayload,
        direction: "inbound",
        sender_id: context.from,
        content: context.content,
        channel_id: context.channelId,
        conversation_id: context.conversationId,
        message_id: context.messageId,
        account_id: context.accountId,
        metadata: { ...context },
      };
    }

    if (isMessageSentEvent(event)) {
      return {
        ...basePayload,
        direction: "outbound",
        sender_id: "openclaw",
        content: context.content,
        channel_id: context.channelId,
        conversation_id: context.conversationId,
        message_id: context.messageId,
        account_id: context.accountId,
        is_group: context.isGroup ?? false,
        group_id: context.groupId,
        metadata: { ...context },
      };
    }

    return basePayload;
  }
}
