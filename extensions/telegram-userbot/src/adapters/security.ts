/**
 * Security adapter for the telegram-userbot channel.
 *
 * Provides DM policy resolution and security warnings.
 */

import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelSecurityAdapter,
} from "openclaw/plugin-sdk";
import type { ResolvedTelegramUserbotAccount } from "./config.js";

const CHANNEL_KEY = "telegram-userbot";

export const telegramUserbotSecurityAdapter: ChannelSecurityAdapter<ResolvedTelegramUserbotAccount> =
  {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const section = cfg.channels?.["telegram-userbot"] as
        | (Record<string, unknown> & { accounts?: Record<string, unknown> })
        | undefined;
      const useAccountPath = Boolean(section?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.${CHANNEL_KEY}.accounts.${resolvedAccountId}.`
        : `channels.${CHANNEL_KEY}.`;

      return {
        // telegram-userbot defaults to allowlist (strict) since userbot accounts
        // are personal accounts and should be protected by default.
        policy: "allowlist",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: `${basePath}allowFrom`,
        approveHint: formatPairingApproveHint(CHANNEL_KEY),
        normalizeEntry: (raw) => raw.replace(/^telegram-userbot:/i, "").trim(),
      };
    },

    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      const allowFrom = account.config.allowFrom ?? [];

      if (allowFrom.length === 0) {
        warnings.push(
          `- Telegram userbot: no allowFrom configured. All incoming DMs will be blocked. Set channels.${CHANNEL_KEY}.allowFrom to allow specific senders.`,
        );
      }

      return warnings;
    },
  };
