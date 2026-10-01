// Defines task terminal outcome contracts used by completion handling.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Terminal fields required when a mandatory detached task completion is invalid. */
export type RequiredCompletionTerminalResult = {
  terminalOutcome?: "blocked";
  terminalSummary?: string;
};

function normalizeCompletionText(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function normalizeCompletionFailureReason(value: string | null | undefined): string {
  const normalized = normalizeCompletionText(value);
  if (!normalized) {
    return "";
  }
  return normalized.length <= 160 ? normalized : `${truncateUtf16Safe(normalized, 159)}...`;
}

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalizedReason = normalizeCompletionFailureReason(reason);
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
