/**
 * Telegram channel — primary user interface.
 * Uses grammY for the bot framework.
 * Supports inline approval buttons and screenshot attachments.
 */

import { Bot, InlineKeyboard, InputFile } from "grammy";
import type { Context as GrammyContext } from "grammy";
import fs from "node:fs/promises";
import type { Router } from "../router/index.js";
import type { ApprovalLevel, Task } from "../types.js";
import { checkRateLimit } from "../security/guards.js";
import type { TokenTracker } from "../monitoring/token-tracker.js";

// ---------------------------------------------------------------------------
// Approval queue — pending tasks awaiting user confirmation
// ---------------------------------------------------------------------------

interface PendingApproval {
  task: Task;
  resolve: (approved: boolean) => void;
  screenshotPath?: string;
}

const pendingApprovals = new Map<string, PendingApproval>();

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

export interface TelegramChannelConfig {
  botToken: string;
  allowedUsers: number[];
  router: Router;
  tokenTracker?: TokenTracker;
}

export function createTelegramBot(config: TelegramChannelConfig): Bot {
  const bot = new Bot(config.botToken);

  // Auth middleware — only respond to allowed users
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId || !config.allowedUsers.includes(userId)) {
      console.warn(`[telegram] Unauthorised access attempt from user ${userId}`);
      await ctx.reply("Unauthorised.");
      return;
    }

    // Rate limit: max 30 messages per minute per user
    if (!checkRateLimit(`telegram:${userId}`, 30, 60_000)) {
      await ctx.reply("Rate limited. Please wait a moment.");
      return;
    }

    await next();
  });

  // Handle text messages → route through classifier
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;

    // Skip if it's a command
    if (text.startsWith("/")) return;

    try {
      await ctx.replyWithChatAction("typing");

      const { task, result } = await config.router.handleMessage(text, "telegram");

      // Check if task needs approval before showing result
      if (task.route.approval !== "none" && result.success) {
        await requestApproval(ctx, task, task.route.approval);
        return;
      }

      // Send result
      const prefix = `[${task.classification.intent}] → ${task.route.agent}`;
      if (result.success) {
        await ctx.reply(`${prefix}\n\n${result.output}`);
      } else {
        await ctx.reply(`${prefix}\n\nError: ${result.error}`);
      }
    } catch (err) {
      await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Handle approval callbacks
  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const taskId = ctx.match![1];
    const pending = pendingApprovals.get(taskId);
    if (pending) {
      pending.resolve(true);
      pendingApprovals.delete(taskId);
      await ctx.editMessageText(`Approved: ${pending.task.input}`);
    }
    await ctx.answerCallbackQuery("Approved");
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const taskId = ctx.match![1];
    const pending = pendingApprovals.get(taskId);
    if (pending) {
      pending.resolve(false);
      pendingApprovals.delete(taskId);
      await ctx.editMessageText(`Rejected: ${pending.task.input}`);
    }
    await ctx.answerCallbackQuery("Rejected");
  });

  // Commands
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Local LLM Router active. Send me any message and I'll route it to the right agent.",
    );
  });

  bot.command("status", async (ctx) => {
    const lines = ["Status: Running", `Pending approvals: ${pendingApprovals.size}`];

    if (config.tokenTracker) {
      try {
        const today = await config.tokenTracker.todaySummary();
        lines.push(``);
        lines.push(`Today: ${today.totalCalls} calls, $${today.totalCostUsd.toFixed(4)}`);
        lines.push(`Tokens: ${formatCompact(today.totalTokens)} (${formatCompact(today.totalInputTokens)} in / ${formatCompact(today.totalOutputTokens)} out)`);
        lines.push(`Local: ${today.byEngine.local.calls} calls | Cloud: ${today.byEngine.cloud.calls} calls`);
      } catch { /* tracker not ready yet */ }
    }

    await ctx.reply(lines.join("\n"));
  });

  bot.command("errors", async (ctx) => {
    await ctx.reply("Error summary coming soon.");
  });

  // /usage [week|month] — token usage dashboard
  bot.command("usage", async (ctx) => {
    if (!config.tokenTracker) {
      await ctx.reply("Token tracking not configured.");
      return;
    }

    try {
      const arg = (ctx.message?.text ?? "").split(" ")[1]?.toLowerCase();
      let summary;

      if (arg === "week") {
        summary = await config.tokenTracker.periodSummary(7);
      } else if (arg === "month") {
        summary = await config.tokenTracker.periodSummary(30);
      } else {
        summary = await config.tokenTracker.todaySummary();
      }

      await ctx.reply(config.tokenTracker.formatForTelegram(summary));
    } catch (err) {
      await ctx.reply(`Error fetching usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // /budget — check budget alerts
  bot.command("budget", async (ctx) => {
    if (!config.tokenTracker) {
      await ctx.reply("Token tracking not configured.");
      return;
    }

    try {
      const alerts = await config.tokenTracker.checkBudget();
      const today = await config.tokenTracker.todaySummary();
      const monthly = await config.tokenTracker.periodSummary(30);

      const lines = [
        `Budget Status`,
        ``,
        `Today: $${today.totalCostUsd.toFixed(4)}`,
        `This month: $${monthly.totalCostUsd.toFixed(4)}`,
        ``,
        config.tokenTracker.formatAlertsForTelegram(alerts),
      ];

      await ctx.reply(lines.join("\n"));
    } catch (err) {
      await ctx.reply(`Error checking budget: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  return bot;
}

// ---------------------------------------------------------------------------
// Approval flow
// ---------------------------------------------------------------------------

/**
 * Request user approval via inline buttons.
 * Optionally includes a screenshot.
 */
async function requestApproval(
  ctx: GrammyContext,
  task: Task,
  level: ApprovalLevel,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingApprovals.set(task.id, { task, resolve });

    const keyboard = new InlineKeyboard()
      .text("Approve", `approve:${task.id}`)
      .text("Reject", `reject:${task.id}`);

    const message = [
      `**Approval Required**`,
      ``,
      `Task: ${task.input}`,
      `Agent: ${task.route.agent}`,
      `Intent: ${task.classification.intent}`,
      `Confidence: ${(task.classification.confidence * 100).toFixed(0)}%`,
    ].join("\n");

    // TODO: If level === "confirm_with_screenshot", attach screenshot
    ctx.reply(message, {
      reply_markup: keyboard,
      parse_mode: "Markdown",
    });
  });
}

/**
 * Send a notification to the user (for alerts, analysis reports, etc).
 */
export async function sendNotification(
  bot: Bot,
  chatId: number,
  message: string,
  opts?: { screenshotPath?: string },
): Promise<void> {
  if (opts?.screenshotPath) {
    try {
      const photo = await fs.readFile(opts.screenshotPath);
      await bot.api.sendPhoto(chatId, new InputFile(photo, "screenshot.png"), {
        caption: message,
      });
      return;
    } catch {
      // Fallback to text if screenshot fails
    }
  }

  await bot.api.sendMessage(chatId, message);
}

/**
 * Send the daily analysis report via Telegram.
 */
export async function sendAnalysisReport(
  bot: Bot,
  chatId: number,
  report: {
    errorCount: number;
    failureRate: number;
    patternsFound: number;
    proposalCount: number;
  },
): Promise<void> {
  const keyboard = new InlineKeyboard()
    .text("View Report", "view_report")
    .text("Apply All", "apply_all")
    .row()
    .text("Review Each", "review_each");

  const message = [
    `Daily Analysis Ready`,
    ``,
    `${report.errorCount} errors (${(report.failureRate * 100).toFixed(0)}% failure rate)`,
    `${report.patternsFound} patterns found`,
    `${report.proposalCount} fixes proposed`,
  ].join("\n");

  await bot.api.sendMessage(chatId, message, {
    reply_markup: keyboard,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
