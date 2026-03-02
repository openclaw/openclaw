import { z } from "zod";

// ---------------------------------------------------------------------------
// Channel meta
// ---------------------------------------------------------------------------

export const TELEGRAM_USERBOT_CHANNEL_ID = "telegram-userbot" as const;

export const telegramUserbotMeta = {
  id: TELEGRAM_USERBOT_CHANNEL_ID,
  label: "Telegram (User)",
  selectionLabel: "Telegram (User Account / MTProto)",
  detailLabel: "Telegram Userbot",
  docsPath: "/channels/telegram-userbot",
  docsLabel: "telegram-userbot",
  blurb: "Connect your own Telegram account via MTProto. Full user capabilities.",
  systemImage: "person.crop.circle",
} as const;

// ---------------------------------------------------------------------------
// Config schema for `channels.telegram-userbot`
// ---------------------------------------------------------------------------

const allowFromEntry = z.union([z.string(), z.number()]);

export const telegramUserbotConfigSchema = z.object({
  /** Telegram API ID from my.telegram.org */
  apiId: z.number({ required_error: "apiId is required (get from my.telegram.org)" }),

  /** Telegram API hash from my.telegram.org */
  apiHash: z.string({ required_error: "apiHash is required (get from my.telegram.org)" }),

  /**
   * Access control — list of allowed sender IDs (numeric Telegram user IDs
   * or string usernames). Same pattern as the telegram bot's allowFrom.
   */
  allowFrom: z.array(allowFromEntry).optional(),

  /** Rate limiting for outbound messages. */
  rateLimit: z
    .object({
      messagesPerSecond: z.number().default(20),
      perChatPerSecond: z.number().default(1),
      jitterMs: z.tuple([z.number(), z.number()]).default([50, 200]),
    })
    .optional(),

  /** Reconnection behaviour. */
  reconnect: z
    .object({
      /** Max reconnect attempts (-1 = infinite). */
      maxAttempts: z.number().default(-1),
      /** Alert after this many consecutive failures. */
      alertAfterFailures: z.number().default(3),
    })
    .optional(),

  /** Feature toggles for the userbot. */
  capabilities: z
    .object({
      /** Allow deleting messages sent by other users. */
      deleteOtherMessages: z.boolean().default(true),
      /** Mark conversations as read. */
      readHistory: z.boolean().default(true),
      /** Send files as documents (no auto-conversion). */
      forceDocument: z.boolean().default(true),
    })
    .optional(),
});

export type TelegramUserbotConfig = z.infer<typeof telegramUserbotConfigSchema>;
