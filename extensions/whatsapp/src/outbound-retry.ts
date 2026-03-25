import { resolveAccountEntry } from "openclaw/plugin-sdk/account-resolution";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  collectErrorGraphCandidates,
  createOutboundRetryRunner,
  extractErrorCode,
  formatErrorMessage,
  readErrorName,
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

// Only retry clearly transient pre-connect errors to avoid duplicate delivery.
const WHATSAPP_PRE_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const WHATSAPP_PRE_CONNECT_ERROR_NAMES = new Set(["ConnectTimeoutError"]);

function collectWhatsAppErrorCandidates(err: unknown) {
  return collectErrorGraphCandidates(err, (current) => {
    const nested: Array<unknown> = [current.cause, current.reason];
    if (Array.isArray(current.errors)) {
      nested.push(...current.errors);
    }
    return nested;
  });
}

export function isRetryableWhatsAppSendError(err: unknown): boolean {
  for (const candidate of collectWhatsAppErrorCandidates(err)) {
    const code = extractErrorCode(candidate)?.trim().toUpperCase();
    if (code && WHATSAPP_PRE_CONNECT_ERROR_CODES.has(code)) {
      return true;
    }
    const name = readErrorName(candidate);
    if (name && WHATSAPP_PRE_CONNECT_ERROR_NAMES.has(name)) {
      return true;
    }
  }
  return false;
}

export function withWhatsAppSendRetry<T>(
  fn: () => Promise<T>,
  label: string,
  configRetry: RetryConfig | undefined,
): Promise<T> {
  return createOutboundRetryRunner({
    defaults: WHATSAPP_SEND_RETRY_DEFAULTS,
    configRetry,
    alwaysLogRetries: true,
    logLabel: "whatsapp",
    shouldRetry: isRetryableWhatsAppSendError,
    logger: log,
    formatRetryMessage: (info) => {
      const maxRetries = Math.max(1, info.maxAttempts - 1);
      return `whatsapp send retry ${info.attempt}/${maxRetries} for ${info.label ?? label} in ${info.delayMs}ms: ${formatErrorMessage(info.err)}`;
    },
  })(fn, label);
}

// Account-level retry takes precedence; falls back to channel-level.
// Uses the effective/default WhatsApp account to match the send path.
export function resolveWhatsAppRetryConfig(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): RetryConfig | undefined {
  const root = cfg?.channels?.whatsapp;
  const effectiveAccountId =
    accountId?.trim() || (cfg ? resolveDefaultWhatsAppAccountId(cfg) : undefined);
  if (effectiveAccountId) {
    const accountCfg = resolveAccountEntry(root?.accounts, effectiveAccountId);
    if (accountCfg?.retry !== undefined) return accountCfg.retry;
  }
  return root?.retry;
}
