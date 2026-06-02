import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { EndReason } from "../../types.js";

const TERMINAL_PROVIDER_STATUS_TO_END_REASON: Record<string, EndReason> = {
  completed: "completed",
  failed: "failed",
  busy: "busy",
  "no-answer": "no-answer",
  canceled: "hangup-bot",
};

/** Normalizes carrier status strings for restore checks while preserving missing as "unknown". */
export function normalizeProviderStatus(status: string | null | undefined): string {
  const normalized = normalizeOptionalLowercaseString(status);
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

/** Maps terminal carrier statuses to OpenClaw end reasons; active/unknown statuses stay null. */
export function mapProviderStatusToEndReason(status: string | null | undefined): EndReason | null {
  const normalized = normalizeProviderStatus(status);
  return TERMINAL_PROVIDER_STATUS_TO_END_REASON[normalized] ?? null;
}

/** Checks whether restore should finalize a local call based on provider status alone. */
export function isProviderStatusTerminal(status: string | null | undefined): boolean {
  return mapProviderStatusToEndReason(status) !== null;
}
