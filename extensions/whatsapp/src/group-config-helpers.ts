import type { WhatsAppGroupConfig } from "../../../src/config/types.js";

/**
 * Resolves the effective systemPrompt for a WhatsApp conversation by merging
 * the account/top-level prompt with an optional per-group prompt (separated by
 * a double newline), mirroring the Telegram two-level merge pattern.
 */
export function resolveWhatsAppGroupSystemPrompt(params: {
  accountSystemPrompt?: string;
  groupConfig?: WhatsAppGroupConfig;
}): string | undefined {
  const parts = [
    params.accountSystemPrompt?.trim() || null,
    params.groupConfig?.systemPrompt?.trim() || null,
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}
