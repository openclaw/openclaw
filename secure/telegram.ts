/**
 * AssureBot - Telegram Channel
 *
 * Minimal, secure Telegram bot handler with image analysis.
 * Allowlist-only: only approved users can interact.
 */

import { Bot, Context } from "grammy";
import type { SecureConfig } from "./config.js";
import type { AuditLogger } from "./audit.js";
import type { AgentCore, ConversationStore, ImageContent } from "./agent.js";
import type { SandboxRunner } from "./sandbox.js";
import type { Scheduler } from "./scheduler.js";
import { extractText, summarizeDocument } from "./documents.js";

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
  sandbox?: SandboxRunner;
  scheduler?: Scheduler;
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
  const { config, audit, agent, conversations, sandbox, scheduler } = deps;
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
      `Welcome to AssureBot.

You are authorized to use this bot.

Commands:
/start - Show this message
/clear - Clear conversation history
/status - Check bot status
/sandbox <code> - Run code in sandbox
/schedule <cron> <task> - Schedule a task
/tasks - List scheduled tasks
/help - Show help

Features:
- Send text messages to chat
- Send images for analysis
- Forward content for analysis`
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
      `AssureBot Help

A secure, self-hosted AI assistant.

Features:
- Chat with AI (text messages)
- Image analysis (send photos)
- Forward content for analysis
- Run code in isolated sandbox
- Schedule recurring AI tasks

Commands:
/start - Welcome message
/clear - Clear conversation history
/status - Bot status
/sandbox <code> - Run code in sandbox
/schedule "<cron>" "<name>" <prompt> - Schedule task
/tasks - List scheduled tasks
/deltask <id> - Delete a task
/help - This message

Security:
- Only authorized users can interact
- All interactions are logged
- Sandbox runs in isolated Docker (no network)`
    );
  });

  // Command: /sandbox <code>
  bot.command("sandbox", async (ctx) => {
    const userId = ctx.from?.id;
    const username = formatUsername(ctx);
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    if (!sandbox) {
      await ctx.reply("Sandbox is not configured.");
      return;
    }

    if (!config.sandbox.enabled) {
      await ctx.reply("Sandbox is disabled.");
      return;
    }

    const code = ctx.message?.text?.replace(/^\/sandbox\s*/, "").trim() ?? "";
    if (!code) {
      await ctx.reply("Usage: /sandbox <code>\n\nExample: /sandbox echo Hello World");
      return;
    }

    const startTime = Date.now();
    await ctx.replyWithChatAction("typing");

    try {
      const result = await sandbox.run(code);
      const output = result.stdout || result.stderr || "(no output)";
      const status = result.exitCode === 0 ? "✓" : `✗ (exit ${result.exitCode})`;
      const timeout = result.timedOut ? " [TIMED OUT]" : "";

      await ctx.reply(
        `**Sandbox Result** ${status}${timeout}\n\`\`\`\n${output.slice(0, 3000)}\n\`\`\`\nDuration: ${result.durationMs}ms`,
        { parse_mode: "Markdown" }
      ).catch(async () => {
        await ctx.reply(`Sandbox Result ${status}${timeout}\n\n${output.slice(0, 3500)}\n\nDuration: ${result.durationMs}ms`);
      });

      audit.sandbox({
        command: code,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      audit.error({ error: `Sandbox error: ${errorMsg}`, metadata: { userId, code } });
      await ctx.reply(`Sandbox error: ${errorMsg}`);
    }
  });

  // Command: /schedule <cron> <name> <prompt>
  bot.command("schedule", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    if (!scheduler) {
      await ctx.reply("Scheduler is not configured.");
      return;
    }

    if (!config.scheduler.enabled) {
      await ctx.reply("Scheduler is disabled.");
      return;
    }

    // Parse: /schedule "*/5 * * * *" "Task Name" What to do
    const text = ctx.message?.text?.replace(/^\/schedule\s*/, "").trim() ?? "";
    const match = text.match(/^"([^"]+)"\s+"([^"]+)"\s+(.+)$/s);
    if (!match) {
      await ctx.reply(
        `Usage: /schedule "<cron>" "<name>" <prompt>

Example:
/schedule "0 9 * * *" "Morning Brief" Give me a summary of what I should focus on today

Cron format: minute hour day month weekday
- "0 9 * * *" = 9:00 AM daily
- "*/30 * * * *" = Every 30 minutes
- "0 0 * * 1" = Midnight on Mondays`
      );
      return;
    }

    const [, cronExpr, name, prompt] = match;

    try {
      const taskId = scheduler.addTask({
        name,
        schedule: cronExpr,
        prompt,
        enabled: true,
      });
      await ctx.reply(`Task scheduled!\n\nID: ${taskId}\nName: ${name}\nSchedule: ${cronExpr}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await ctx.reply(`Failed to schedule task: ${errorMsg}`);
    }
  });

  // Command: /tasks
  bot.command("tasks", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    if (!scheduler) {
      await ctx.reply("Scheduler is not configured.");
      return;
    }

    const tasks = scheduler.listTasks();
    if (tasks.length === 0) {
      await ctx.reply("No scheduled tasks.\n\nUse /schedule to create one.");
      return;
    }

    const lines = tasks.map((t) => {
      const status = t.enabled ? "✓" : "✗";
      const lastRun = t.lastRun ? t.lastRun.toISOString().slice(0, 16) : "never";
      return `${status} **${t.name}** (${t.id})\n   ${t.schedule}\n   Last: ${lastRun}`;
    });

    await ctx.reply(`**Scheduled Tasks**\n\n${lines.join("\n\n")}`, { parse_mode: "Markdown" }).catch(async () => {
      await ctx.reply(`Scheduled Tasks\n\n${lines.join("\n\n").replace(/\*\*/g, "")}`);
    });
  });

  // Command: /deltask <id>
  bot.command("deltask", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      return;
    }

    if (!scheduler) {
      await ctx.reply("Scheduler is not configured.");
      return;
    }

    const taskId = ctx.message?.text?.replace(/^\/deltask\s*/, "").trim() ?? "";
    if (!taskId) {
      await ctx.reply("Usage: /deltask <task_id>");
      return;
    }

    if (scheduler.removeTask(taskId)) {
      await ctx.reply(`Task ${taskId} deleted.`);
    } else {
      await ctx.reply(`Task ${taskId} not found.`);
    }
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
    const username = formatUsername(ctx);

    if (!userId || !isUserAllowed(userId, config.telegram.allowedUsers)) {
      audit.messageBlocked({
        userId: userId || 0,
        username,
        reason: "User not in allowlist",
      });
      return;
    }

    const startTime = Date.now();
    const caption = ctx.message.caption || "What's in this image? Describe it in detail.";

    try {
      await ctx.replyWithChatAction("typing");

      // Get the largest photo (last in array)
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];

      // Get file info
      const file = await ctx.api.getFile(photo.file_id);
      if (!file.file_path) {
        await ctx.reply("Sorry, I couldn't download the image.");
        return;
      }

      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        await ctx.reply("Sorry, I couldn't download the image.");
        return;
      }

      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");

      // Determine media type from file path
      const ext = file.file_path.split(".").pop()?.toLowerCase();
      let mediaType: ImageContent["mediaType"] = "image/jpeg";
      if (ext === "png") mediaType = "image/png";
      else if (ext === "gif") mediaType = "image/gif";
      else if (ext === "webp") mediaType = "image/webp";

      // Analyze with AI
      const result = await agent.analyzeImage(base64, mediaType, caption);

      await ctx.reply(result.text, { parse_mode: "Markdown" }).catch(async () => {
        await ctx.reply(result.text);
      });

      audit.message({
        userId,
        username,
        text: `[IMAGE] ${caption}`,
        response: result.text,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      audit.error({
        error: `Failed to analyze image: ${errorMsg}`,
        metadata: { userId, username },
      });
      await ctx.reply("Sorry, I couldn't analyze that image. Please try again.");
    }
  });

  // Handle documents
  bot.on("message:document", async (ctx) => {
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

    const doc = ctx.message?.document;
    if (!doc) {
      await ctx.reply("Could not process document.");
      return;
    }

    const startTime = Date.now();
    const caption = ctx.message?.caption || "Please analyze this document and summarize the key points.";

    try {
      await ctx.replyWithChatAction("typing");

      // Check file size (max 20MB)
      if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
        await ctx.reply("Document too large (max 20MB).");
        return;
      }

      // Get file info
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) {
        await ctx.reply("Could not download document.");
        return;
      }

      // Download the file
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        await ctx.reply("Failed to download document.");
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = doc.mime_type || "application/octet-stream";

      // Extract text
      const extracted = await extractText(buffer, mimeType, doc.file_name);

      if (extracted.format === "unsupported") {
        await ctx.reply(
          `Unsupported document format: ${mimeType}\n\nSupported: PDF, TXT, MD, JSON, CSV, code files`
        );
        return;
      }

      if (extracted.format === "pdf-error") {
        await ctx.reply(`Could not parse PDF: ${extracted.text}`);
        return;
      }

      // Analyze with AI
      const result = await agent.chat([
        {
          role: "user",
          content: `${caption}\n\n--- Document Content (${summarizeDocument(extracted)}) ---\n\n${extracted.text}`,
        },
      ]);

      await ctx.reply(result.text, { parse_mode: "Markdown" }).catch(async () => {
        await ctx.reply(result.text);
      });

      audit.message({
        userId,
        username,
        text: `[DOCUMENT: ${doc.file_name || "unnamed"}] ${caption}`,
        response: result.text,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      audit.error({
        error: `Failed to analyze document: ${errorMsg}`,
        metadata: { userId, username, filename: doc.file_name },
      });
      await ctx.reply("Sorry, I couldn't analyze that document. Please try again.");
    }
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
