/**
 * E2E tests for Telegram notification via @findoo_agent_bot.
 * Verifies that the bot can send formatted messages and inline approval buttons.
 *
 * Requires environment variables:
 *   FINDOO_TELEGRAM_E2E=1
 *   FINDOO_TELEGRAM_BOT_TOKEN=<bot token>
 *   FINDOO_TELEGRAM_CHAT_ID=<chat id>
 *
 * Run:
 *   FINDOO_TELEGRAM_E2E=1 FINDOO_TELEGRAM_BOT_TOKEN=... FINDOO_TELEGRAM_CHAT_ID=... \
 *     npx vitest run extensions/findoo-trader-plugin/test/e2e/telegram-notification.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

// Load .env from repo root
try {
  const envPath = resolve(import.meta.dirname ?? ".", "../../../../.env");
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  // .env not found — rely on environment variables
}

const BOT_TOKEN = process.env.FINDOO_TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.FINDOO_TELEGRAM_CHAT_ID;
const SKIP = !process.env.FINDOO_TELEGRAM_E2E || !BOT_TOKEN || !CHAT_ID;

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendTelegramRequest(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<{ ok: boolean; result: Record<string, unknown> }>;
}

describe.skipIf(SKIP)("Telegram E2E Notification", () => {
  it("should send a plain HTML notification", async () => {
    const text = [
      `\u2705<b> BUY 0.1 BTC/USDT</b>`,
      ``,
      `Order filled at $45,022.50 — SMA crossover signal.`,
      ``,
      `<i>${new Date().toISOString()} | trade_executed | e2e-test-001</i>`,
    ].join("\n");

    const result = await sendTelegramRequest("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
    });

    expect(result.ok).toBe(true);
    expect(result.result.text).toContain("BUY 0.1 BTC/USDT");
  });

  it("should send a notification with inline approval buttons", async () => {
    const eventId = `e2e-test-${Date.now()}`;
    const text = [
      `\u23f3<b> [ACTION REQUIRED] BUY 0.5 ETH/USDT</b>`,
      ``,
      `Estimated value $1,750.00 exceeds auto-trade limit ($100).`,
      `Awaiting manual approval.`,
      ``,
      `<i>${new Date().toISOString()} | trade_pending | ${eventId}</i>`,
    ].join("\n");

    const result = await sendTelegramRequest("sendMessage", {
      chat_id: CHAT_ID,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "\u2705 Approve", callback_data: `fin_approve:${eventId}` },
            { text: "\u274c Reject", callback_data: `fin_reject:${eventId}` },
          ],
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.result.reply_markup).toBeDefined();
  });
});
