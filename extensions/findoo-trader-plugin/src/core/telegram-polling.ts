/**
 * Telegram Bot long-polling bridge for callback_query events.
 *
 * Receives inline button clicks (approve/reject) from Telegram and routes
 * them through the existing processApproval flow. This bridges the gap
 * where OpenClaw's plugin API does not expose a callback_query hook.
 */

import { Bot } from "grammy";
import type { AgentEventSqliteStore } from "./agent-event-sqlite-store.js";
import { processApproval } from "./telegram-approval.js";

type LifecycleEngineLike = {
  handleApproval(strategyId: string): boolean;
  handleRejection(strategyId: string, reason?: string): boolean;
};

export interface TelegramPollingOpts {
  botToken: string;
  eventStore: AgentEventSqliteStore;
  lifecycleEngineResolver?: () => LifecycleEngineLike | undefined;
}

export function startTelegramPolling(opts: TelegramPollingOpts): { stop: () => void } {
  const bot = new Bot(opts.botToken);
  let stopped = false;

  // Global error handler — prevents unhandled rejections from crashing the process
  bot.catch((err) => {
    const msg = err.message ?? String(err);
    if (msg.includes("409") || msg.includes("Conflict")) {
      console.warn(
        "[telegram-polling] 409 Conflict — another bot instance is using the same token. Stopping polling.",
      );
      if (!stopped) {
        stopped = true;
        bot.stop();
      }
      return;
    }
    console.error("[telegram-polling] Grammy error:", msg);
  });

  bot.on("callback_query:data", async (ctx) => {
    const callbackData = ctx.callbackQuery.data;
    const chatId = String(ctx.chat?.id ?? "");
    const messageId = ctx.callbackQuery.message?.message_id ?? 0;

    if (!callbackData || !chatId) {
      await ctx.answerCallbackQuery("Invalid callback");
      return;
    }

    const result = await processApproval(
      opts.eventStore,
      { callbackData, chatId, messageId },
      { telegramBotToken: opts.botToken },
    );

    // Bridge to LifecycleEngine for L3 promotion approvals
    if (result.ok && opts.lifecycleEngineResolver) {
      const event = opts.eventStore.getEvent(result.eventId);
      if (event?.actionParams?.action === "promote_l3") {
        const engine = opts.lifecycleEngineResolver();
        const strategyId = event.actionParams.strategyId as string;
        if (engine && strategyId) {
          if (result.action === "approve") {
            engine.handleApproval(strategyId);
          } else {
            engine.handleRejection(strategyId);
          }
        }
      }
    }

    await ctx.answerCallbackQuery(
      result.ok ? "\u2705 Done" : "\u274c " + (result.error ?? "Failed"),
    );
  });

  // Start long-polling (non-blocking) with error handling.
  // Grammy's bot.start() returns a long-running promise whose internal
  // getUpdates loop can throw rejections that bypass bot.catch().
  // We attach a process-level handler as a safety net so 409 Conflict
  // (another bot instance) never crashes the gateway.
  const onUnhandledRejection = (err: unknown) => {
    const msg = String(err);
    if (msg.includes("409") || msg.includes("Conflict") || msg.includes("getUpdates")) {
      console.warn(
        "[telegram-polling] Caught unhandled rejection (409 Conflict) — stopping polling gracefully.",
      );
      if (!stopped) {
        stopped = true;
        try {
          bot.stop();
        } catch {
          /* noop */
        }
      }
      return;
    }
  };
  process.on("unhandledRejection", onUnhandledRejection);

  bot
    .start({
      onStart: () => {
        console.log("[telegram-polling] Bot started successfully");
      },
    })
    .catch((err) => {
      const msg = err?.message ?? String(err);
      if (msg.includes("409") || msg.includes("Conflict")) {
        console.warn(
          "[telegram-polling] 409 Conflict on start — another instance already polling. Giving up gracefully.",
        );
      } else {
        console.error("[telegram-polling] Failed to start:", msg);
      }
      stopped = true;
    });

  return {
    stop: () => {
      if (!stopped) {
        stopped = true;
        try {
          bot.stop();
        } catch {
          /* noop */
        }
      }
      process.removeListener("unhandledRejection", onUnhandledRejection);
    },
  };
}
