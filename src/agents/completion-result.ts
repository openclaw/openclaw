// Defines task terminal outcome contracts used by completion handling.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

/** Terminal fields required when a mandatory detached task completion is invalid. */
export type RequiredCompletionTerminalResult = {
  terminalOutcome?: "blocked";
  terminalSummary?: string;
};

export function resolveRequiredCompletionDeliveryFailureTerminalResult(
  reason: string | null | undefined,
): RequiredCompletionTerminalResult {
  const normalized = reason?.replace(/\s+/g, " ").trim() ?? "";
  const normalizedReason =
    normalized.length <= 160 ? normalized : `${truncateUtf16Safe(normalized, 159)}...`;
  return {
    terminalOutcome: "blocked",
    terminalSummary: normalizedReason
      ? `Required completion delivery failed before reaching the requester: ${normalizedReason}.`
      : "Required completion delivery failed before reaching the requester.",
  };
}
