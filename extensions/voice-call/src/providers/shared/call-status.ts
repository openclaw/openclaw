import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EndReason } from "../../types.js";

const TERMINAL_PROVIDER_STATUS_TO_END_REASON = new Map<string, EndReason>([
  ["completed", "completed"],
  ["failed", "failed"],
  ["busy", "busy"],
  ["no-answer", "no-answer"],
  ["canceled", "hangup-bot"],
]);

/** Normalize provider status text, falling back to "unknown". */
export function normalizeProviderStatus(status: string | null | undefined): string {
  return normalizeOptionalLowercaseString(status) ?? "unknown";
}

export function mapProviderStatusToEndReason(status: string | null | undefined): EndReason | null {
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON.get(normalizeProviderStatus(status)) ?? null;
}

export function isProviderStatusTerminal(status: string | null | undefined): boolean {
  return mapProviderStatusToEndReason(status) !== null;
}
