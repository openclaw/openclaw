/**
 * Moltbot Secure - Telegram Channel
 *
 * Minimal, secure Telegram bot handler.
 * Allowlist-only: only approved users can interact.
 */

import { Bot, Context } from "grammy";
import type { SecureConfig } from "./config.js";
import type { AuditLogger } from "./audit.js";
import type { AgentCore, ConversationStore } from "./agent.js";

export type TelegramBot = {
  bot: Bot;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export type TelegramDeps = {
  config: SecureConfig;
  audit: AuditLogger;
  agent: AgentCore;
  conversations: ConversationStore;
  onWebhookMessage?: (userId: number, text: string) => void;
};

function isUserAllowed(userId: number, allowedUsers: number[]): boolean {
  return allowedUsers.includes(userId);
}

function formatUsername(ctx: Context): string {
  const user = ctx.from;
  if (!user) return "unknown";
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ");
  return name || `id:${user.id}`;
}

export function createTelegramBot(deps: TelegramDeps): TelegramBot {
  const { config, audit, agent, conversations } = deps;
  const bot = new Bot(config.telegram.botToken);

  // Error handler
  bot.catch((err) => {
    audit.error({
      error: `Telegram bot error: ${err.message}`,
      metadata: { stack: err.stack },
    });
  });

  // Command: /start
  bot.command("start", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      audit.messageBlocked({
        userId: userId || 0,
        username: formatUsername(ctx),
        reason: "User not in allowlist",
      });
      await ctx.reply("Access denied. You are not authorized to use this bot.");
      return;
    }

    await ctx.reply(
      `Welcome to Moltbot Secure.

You are authorized to use this bot.

Commands:
/start - Show this message
/clear - Clear conversation history
/status - Check bot status
/help - Show help

Just send me a message to chat!`
    );
  });

  // Command: /clear
  bot.command("clear", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    conversations.clear(userId);
    await ctx.reply("Conversation history cleared.");
  });

  // Command: /status
  bot.command("status", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    const history = conversations.get(userId);
    await ctx.reply(
      `Status:
- AI Provider: ${agent.provider}
- Conversation: ${history.length} messages
- Sandbox: ${config.sandbox.enabled ? "enabled" : "disabled"}
- Webhooks: ${config.webhooks.enabled ? "enabled" : "disabled"}
- Scheduler: ${config.scheduler.enabled ? "enabled" : "disabled"}`
    );
  });

  // Command: /help
  bot.command("help", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    await ctx.reply(
      `Moltbot Secure Help

This is a secure, self-hosted AI assistant.

Features:
- Chat with AI (text messages)
- Forward content for analysis
- Receive webhook notifications

Commands:
/start - Welcome message
/clear - Clear conversation history
/status - Bot status
/help - This message

Security:
- Only authorized users can interact
- All interactions are logged
- No data is sent to third parties (except AI provider)`
    );
  });

  // Handle all text messages
  bot.on("message:text", async (ctx) => {
    const userId = ctx.from?.id;
    const username = formatUsername(ctx);
    const text = ctx.message.text;

    if (!userId) return;

    // Check allowlist
    if (!isUserAllowed(userId, config.telegram.allowedUsers)) {
      audit.messageBlocked({
        userId,
        username,
        reason: "User not in allowlist",
      });
      await ctx.reply("Access denied. You are not authorized to use this bot.");
      return;
    }

    // Skip commands (handled above)
    if (text.startsWith("/")) return;

    const startTime = Date.now();

    try {
      // Show typing indicator
      await ctx.replyWithChatAction("typing");

      // Add user message to history
      conversations.add(userId, { role: "user", content: text });

      // Get conversation history
      const history = conversations.get(userId);

      // Call AI
      const response = await agent.chat(history);

      // Add assistant response to history
      conversations.add(userId, { role: "assistant", content: response.text });

      // Send response
      await ctx.reply(response.text, { parse_mode: "Markdown" }).catch(async () => {
        // Fallback without markdown if it fails
        await ctx.reply(response.text);
      });

      // Audit log
      audit.message({
        userId,
        username,
        text,
        response: response.text,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      audit.error({
        error: `Failed to process message: ${errorMsg}`,
        metadata: { userId, username },
      });

      await ctx.reply("Sorry, I encountered an error processing your message. Please try again.");
    }
  });

  // Handle forwarded messages
  bot.on("message:forward_origin", async (ctx) => {
    const userId = ctx.from?.id;
    const username = formatUsername(ctx);

    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      audit.messageBlocked({
        userId: userId || 0,
        username,
        reason: "User not in allowlist",
      });
      return;
    }

    const text = ctx.message.text || ctx.message.caption || "";
    if (!text) {
      await ctx.reply("I received your forwarded message but couldn't extract any text.");
      return;
    }

    const startTime = Date.now();

    try {
      await ctx.replyWithChatAction("typing");

      // Process as a standalone analysis (don't add to conversation history)
      const response = await agent.chat([
        {
          role: "user",
          content: `Please analyze this forwarded message:\n\n${text}`,
        },
      ]);

      await ctx.reply(response.text, { parse_mode: "Markdown" }).catch(async () => {
        await ctx.reply(response.text);
      });

      audit.message({
        userId,
        username,
        text: `[FORWARDED] ${text}`,
        response: response.text,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      audit.error({
        error: `Failed to process forwarded message: ${err instanceof Error ? err.message : String(err)}`,
      });
      await ctx.reply("Sorry, I couldn't analyze that forwarded message.");
    }
  });

  // Handle photos
  bot.on("message:photo", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    await ctx.reply(
      "I received your image. Image analysis is available with Claude - please describe what you'd like me to analyze."
    );
  });

  // Handle documents
  bot.on("message:document", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    await ctx.reply(
      "I received your document. Document analysis coming soon - for now, please copy/paste the text content."
    );
  });

  return {
    bot,

    async start(): Promise<void> {
      console.log("[telegram] Starting bot in polling mode...");
      await bot.start({
        onStart: (botInfo) => {
          console.log(`[telegram] Bot started: @${botInfo.username}`);
        },
      });
    },

    async stop(): Promise<void> {
      console.log("[telegram] Stopping bot...");
      await bot.stop();
    },
  };
}

/**
 * Send a message to a user (for webhook notifications, cron results, etc.)
 */
export async function sendToUser(
  bot: Bot,
  userId: number,
  message: string
): Promise<boolean> {
  try {
    await bot.api.sendMessage(userId, message, { parse_mode: "Markdown" }).catch(async () => {
      // Fallback without markdown
      await bot.api.sendMessage(userId, message);
    });
    return true;
  } catch (err) {
    console.error(`[telegram] Failed to send message to ${userId}:`, err);
    return false;
  }
}
