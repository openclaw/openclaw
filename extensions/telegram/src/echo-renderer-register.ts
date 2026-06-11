import { Bot } from "grammy";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { getOrCreateAccountThrottler } from "./account-throttler.js";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramStreamMode, type TelegramThreadSpec } from "./bot/helpers.js";
import { resolveTelegramClientOptions } from "./client-options.js";
import { createTelegramEchoRenderer } from "./echo-renderer.js";

let registered = false;

function normalizeTelegramChatId(to: string): string | number {
  const trimmed = to
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .replace(/^group:/i, "")
    .trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

/**
 * Register the Telegram native streaming echo renderer factory (B-full). Idempotent;
 * safe to call from every bot start. When a streaming-enabled echo target lives on a
 * Telegram account, the core fan-out uses this to render the origin run live on that
 * chat via the account's own Bot api.
 *
 * Reuses the channel's own stream config: a target whose account has streaming off
 * returns undefined here and falls back to the post-hoc final mirror.
 */
export function registerTelegramEchoRenderer(
  api: Pick<OpenClawPluginApi, "registrationMode" | "registerEchoRendererFactory">,
): void {
  if (api.registrationMode !== "full") {
    return;
  }
  if (registered) {
    return;
  }
  api.registerEchoRendererFactory(({ cfg, target }) => {
    let account: ReturnType<typeof resolveTelegramAccount>;
    try {
      account = resolveTelegramAccount({ cfg, accountId: target.accountId });
    } catch {
      return undefined;
    }
    if (!account?.token) {
      return undefined;
    }
    const streamMode = resolveTelegramStreamMode(account.config);
    if (streamMode === "off") {
      return undefined;
    }
    const client = resolveTelegramClientOptions(account);
    const bot = new Bot(account.token, client ? { client } : undefined);
    bot.api.config.use(getOrCreateAccountThrottler(account.token));
    const textLimit = resolveTextChunkLimit(cfg, "telegram", account.accountId);
    const threadIdNum = target.threadId != null ? Number(target.threadId) : Number.NaN;
    const thread: TelegramThreadSpec | null = Number.isFinite(threadIdNum)
      ? { id: threadIdNum, scope: "forum" }
      : null;
    return createTelegramEchoRenderer({
      api: bot.api,
      chatId: normalizeTelegramChatId(target.to),
      thread,
      cfg,
      accountId: account.accountId,
      streamingEntry: account.config,
      streamMode,
      textLimit,
    });
  });
  registered = true;
}

export function resetTelegramEchoRendererRegistrationForTest(): void {
  registered = false;
}
