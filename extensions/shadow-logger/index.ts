import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-logger";
import { registerInternalHook, type InternalHookEvent, isMessageReceivedEvent, isMessageSentEvent } from "openclaw/plugin-sdk/hook-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/types";
import { createSupabaseClient } from "./supabase-client.js";

/**
 * ShadowLoggerPlugin
 * 
 * Captures received and sent messages via internal hooks and 
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
      const { error } = await this.supabase.schema("shadow_log").from("messages").insert(payload);

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
      const ctx = context as any;
      const metadata = ctx.metadata || {};
      return {
        ...basePayload,
        direction: "received",
        sender_id: ctx.from,
        content: ctx.content,
        channel_id: ctx.channelId,
        conversation_id: ctx.conversationId,
        message_id: ctx.messageId,
        account_id: ctx.accountId,
        is_group: ctx.isGroup ?? metadata.isGroup ?? false,
        group_id: ctx.groupId ?? metadata.groupId,
        metadata: { ...context },
      };
    }

    if (isMessageSentEvent(event)) {
      return {
        ...basePayload,
        direction: "sent",
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
