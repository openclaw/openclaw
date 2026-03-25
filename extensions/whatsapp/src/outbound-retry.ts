import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  formatErrorMessage,
  resolveRetryConfig,
  retryAsync,
  type RetryConfig,
} from "openclaw/plugin-sdk/infra-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { resolveDefaultWhatsAppAccountId } from "./accounts.js";

const log = createSubsystemLogger("gateway/channels/whatsapp").child("send-retry");

export const WHATSAPP_SEND_RETRY_DEFAULTS = {
  attempts: 3,
  minDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitter: 0.1,
} satisfies Required<RetryConfig>;

// Only retry clearly transient network errors to avoid duplicate message delivery.
const WHATSAPP_SEND_RETRY_RE = /timeout|connect|reset|closed|unavailable|temporarily/i;

function shouldRetryWhatsAppSend(err: unknown): boolean {
  return WHATSAPP_SEND_RETRY_RE.test(formatErrorMessage(err));
}

export function withWhatsAppSendRetry<T>(
  fn: () => Promise<T>,
  label: string,
  configRetry: RetryConfig | undefined,
): Promise<T> {
  const resolved = resolveRetryConfig(WHATSAPP_SEND_RETRY_DEFAULTS, configRetry);
  return retryAsync(fn, {
    ...resolved,
    label,
    shouldRetry: shouldRetryWhatsAppSend,
    onRetry: (info) => {
      const maxRetries = Math.max(1, info.maxAttempts - 1);
      log.warn(
        `whatsapp send retry ${info.attempt}/${maxRetries} for ${info.label ?? label} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`,
      );
    },
  });
}

// Account-level retry takes precedence; falls back to channel-level.
// Resolves the effective account id (including the default account) so that
// channels.whatsapp.accounts.<default-id>.retry is honored even when no
// explicit accountId is passed by the caller. Uses case-insensitive lookup
// via resolveAccountEntry to match WhatsApp account resolution elsewhere.
export function resolveWhatsAppRetryConfig(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): RetryConfig | undefined {
  const root = cfg?.channels?.whatsapp;
  const effectiveAccountId = accountId?.trim() || (cfg && resolveDefaultWhatsAppAccountId(cfg));
  if (effectiveAccountId) {
    const accountCfg = resolveAccountEntry(root?.accounts, effectiveAccountId);
    if (accountCfg?.retry !== undefined) return accountCfg.retry;
  }
  return root?.retry;
}
