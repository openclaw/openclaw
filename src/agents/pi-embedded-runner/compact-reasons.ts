import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { sanitizeForLog } from "../../terminal/ansi.js";

const MAX_COMPACTION_REASON_DETAIL_CHARS = 100;

/**
 * Closed union of compaction-attempt outcomes returned by
 * {@link classifyCompactionReason}. Replaces the prior bare `string` return,
 * which forced consumers to substring-match on free-form messages.
 *
 * Add new variants here when the classifier learns a new shape.
 */
export type CompactionReasonCode =
  | "unknown"
  | "no_compactable_entries"
  | "no_real_conversation_messages"
  | "unknown_model"
  | "below_threshold"
  | "already_compacted_recently"
  | "live_context_still_exceeds_target"
  | "guard_blocked"
  | "summary_failed"
  | "timeout"
  | "provider_error_4xx"
  | "provider_error_5xx";

/**
 * Reason codes that mean "compaction did not run, but for a legitimate
 * non-error cause" — caller should treat the request as gracefully skipped
 * rather than as a failure.
 *
 * Single source of truth shared by the request-compaction tool and the
 * /compact command.
 */
const SKIP_CODES: ReadonlySet<CompactionReasonCode> = new Set([
  "no_compactable_entries",
  "no_real_conversation_messages",
  "below_threshold",
  "already_compacted_recently",
]);

export function isCompactionSkipCode(code: CompactionReasonCode): boolean {
  return SKIP_CODES.has(code);
}

/**
 * Convenience wrapper: classify a free-form reason string, then check whether
 * the resulting code is a skip-class outcome. Replaces the duplicated
 * `isLegitSkipReason` / `isCompactionSkipReason` substring helpers.
 */
export function isCompactionSkipReason(reason?: string): boolean {
  return isCompactionSkipCode(classifyCompactionReason(reason));
}

function isGenericCompactionCancelledReason(reason: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(reason);
  return normalized === "compaction cancelled" || normalized === "error: compaction cancelled";
}

export function resolveCompactionFailureReason(params: {
  reason: string;
  safeguardCancelReason?: string | null;
}): string {
  if (isGenericCompactionCancelledReason(params.reason) && params.safeguardCancelReason) {
    return params.safeguardCancelReason;
  }
  return params.reason;
}

export function classifyCompactionReason(reason?: string): CompactionReasonCode {
  const text = normalizeLowercaseStringOrEmpty(reason);
  if (!text) {
    return "unknown";
  }
  if (text.includes("nothing to compact")) {
    return "no_compactable_entries";
  }
  if (text.includes("no real conversation messages")) {
    return "no_real_conversation_messages";
  }
  if (text.includes("unknown model")) {
    // Surfaced when DEFAULT_PROVIDER/DEFAULT_MODEL fallback hits an unsupported
    // model, e.g. volitional compaction without provider/model passed.
    return "unknown_model";
  }
  if (text.includes("below threshold")) {
    return "below_threshold";
  }
  if (text.includes("already compacted")) {
    return "already_compacted_recently";
  }
  if (text.includes("still exceeds target")) {
    return "live_context_still_exceeds_target";
  }
  if (text.includes("guard")) {
    return "guard_blocked";
  }
  if (text.includes("summary")) {
    return "summary_failed";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "timeout";
  }
  if (
    text.includes("400") ||
    text.includes("401") ||
    text.includes("403") ||
    text.includes("429")
  ) {
    return "provider_error_4xx";
  }
  if (
    text.includes("500") ||
    text.includes("502") ||
    text.includes("503") ||
    text.includes("504")
  ) {
    return "provider_error_5xx";
  }
  return "unknown";
}

export function formatUnknownCompactionReasonDetail(reason?: string): string | undefined {
  const sanitized = sanitizeForLog((reason ?? "").replace(/\s+/g, " "))
    .trim()
    .replace(/[^A-Za-z0-9._:@/+~-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) {
    return undefined;
  }
  return sanitized.slice(0, MAX_COMPACTION_REASON_DETAIL_CHARS);
}
