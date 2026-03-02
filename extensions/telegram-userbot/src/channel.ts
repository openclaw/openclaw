/**
 * ChannelPlugin definition for the telegram-userbot channel.
 *
 * Wires together all adapters (config, setup, auth, status, security,
 * gateway) into a single ChannelPlugin object that OpenClaw's channel
 * registry consumes.
 */

import type { ChannelPlugin } from "openclaw/plugin-sdk";
import { telegramUserbotAuthAdapter } from "./adapters/auth.js";
import {
  telegramUserbotConfigAdapter,
  resolveTelegramUserbotAccount,
  type ResolvedTelegramUserbotAccount,
} from "./adapters/config.js";
import { telegramUserbotOutboundAdapter } from "./adapters/outbound.js";
import { telegramUserbotSecurityAdapter } from "./adapters/security.js";
import { telegramUserbotSetupAdapter } from "./adapters/setup.js";
import { telegramUserbotStatusAdapter, type TelegramUserbotProbe } from "./adapters/status.js";
import { telegramUserbotMeta, TELEGRAM_USERBOT_CHANNEL_ID } from "./config-schema.js";
import { ConnectionManager } from "./connection.js";

// ---------------------------------------------------------------------------
// Per-account ConnectionManager instances
// ---------------------------------------------------------------------------

const connectionManagers = new Map<string, ConnectionManager>();

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const telegramUserbotPlugin: ChannelPlugin<
  ResolvedTelegramUserbotAccount,
  TelegramUserbotProbe
> = {
  id: TELEGRAM_USERBOT_CHANNEL_ID,
  meta: {
    ...telegramUserbotMeta,
  },

  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
    edit: true,
    unsend: true,
    reply: true,
  },

  reload: { configPrefixes: [`channels.${TELEGRAM_USERBOT_CHANNEL_ID}`] },

  // -------------------------------------------------------------------------
  // Adapters
  // -------------------------------------------------------------------------

  config: telegramUserbotConfigAdapter,
  setup: telegramUserbotSetupAdapter,
  auth: telegramUserbotAuthAdapter,
  status: telegramUserbotStatusAdapter,
  security: telegramUserbotSecurityAdapter,
  outbound: telegramUserbotOutboundAdapter,

  // -------------------------------------------------------------------------
  // Gateway — manages the MTProto connection lifecycle
  // -------------------------------------------------------------------------

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.configured) {
        throw new Error(
          `telegram-userbot is not configured for account "${account.accountId}" (need apiId and apiHash in channels.telegram-userbot).`,
        );
      }

      ctx.log?.info(
        `[${account.accountId}] starting telegram-userbot provider (apiId=${account.apiId})`,
      );

      const manager = new ConnectionManager({
        apiId: account.apiId,
        apiHash: account.apiHash,
        accountId: account.accountId,
        reconnect: account.config.reconnect,
      });

      connectionManagers.set(account.accountId, manager);

      // Wire connection events to the gateway status sink.
      manager.on("connected", ({ username, userId }: { username?: string; userId?: number }) => {
        ctx.log?.info(
          `[${account.accountId}] connected${username ? ` as @${username}` : ""}${userId ? ` (${userId})` : ""}`,
        );
        ctx.setStatus({
          accountId: account.accountId,
          connected: true,
          running: true,
          lastConnectedAt: Date.now(),
          lastError: null,
          profile: username ? { username, userId } : undefined,
        });
      });

      manager.on("disconnected", ({ reason }: { reason: string }) => {
        ctx.log?.warn(`[${account.accountId}] disconnected: ${reason}`);
        ctx.setStatus({
          accountId: account.accountId,
          connected: false,
          lastDisconnect: { at: Date.now(), error: reason },
        });
      });

      manager.on("reconnecting", ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
        ctx.log?.info(
          `[${account.accountId}] reconnecting (attempt ${attempt}, delay ${delayMs}ms)`,
        );
        ctx.setStatus({
          accountId: account.accountId,
          reconnectAttempts: attempt,
        });
      });

      manager.on("authError", ({ error }: { error: Error }) => {
        ctx.log?.error(`[${account.accountId}] auth error: ${error.message}`);
        ctx.setStatus({
          accountId: account.accountId,
          connected: false,
          lastError: error.message,
        });
      });

      manager.on("alertNeeded", ({ failures }: { failures: number }) => {
        ctx.log?.warn(`[${account.accountId}] alert: ${failures} consecutive connection failures`);
      });

      // Set initial status
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
      });

      // Start connection
      await manager.start();

      // Wait until abort signal fires (gateway lifecycle).
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          resolve();
          return;
        }
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });

      // Cleanup on stop
      await manager.stop();
      connectionManagers.delete(account.accountId);

      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        connected: false,
        lastStopAt: Date.now(),
      });
    },

    stopAccount: async (ctx) => {
      const manager = connectionManagers.get(ctx.accountId);
      if (manager) {
        await manager.stop();
        connectionManagers.delete(ctx.accountId);
      }
    },
  },

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  pairing: {
    idLabel: "telegramUserbotSenderId",
    normalizeAllowEntry: (entry) => entry.replace(/^telegram-userbot:/i, "").trim(),
  },

  // -------------------------------------------------------------------------
  // Messaging
  // -------------------------------------------------------------------------

  messaging: {
    normalizeTarget: (raw) => {
      const trimmed = raw?.trim();
      if (!trimmed) return undefined;
      // Strip channel prefix if present
      return trimmed.replace(/^telegram-userbot:/i, "");
    },
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw?.trim();
        if (!trimmed) return false;
        // Numeric IDs or @usernames
        return /^\d+$/.test(trimmed) || /^@\w+$/.test(trimmed);
      },
      hint: "<userId|@username>",
    },
  },
};

// ---------------------------------------------------------------------------
// Expose the ConnectionManager map for use by other adapters
// ---------------------------------------------------------------------------

export function getConnectionManager(accountId: string): ConnectionManager | undefined {
  return connectionManagers.get(accountId);
}
