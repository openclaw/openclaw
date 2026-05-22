/**
 * Closed union of compaction-attempt outcomes returned by
 * {@link classifyCompactionReason}. Replaces the prior bare `string` return,
 * which forced consumers to substring-match on free-form messages.
 *
 * Add new variants here when the classifier learns a new shape.
 */
export type CompactionReasonCode = "unknown" | "no_compactable_entries" | "no_real_conversation_messages" | "unknown_model" | "below_threshold" | "already_compacted_recently" | "live_context_still_exceeds_target" | "guard_blocked" | "summary_failed" | "timeout" | "provider_error_4xx" | "provider_error_5xx";
export declare function isCompactionSkipCode(code: CompactionReasonCode): boolean;
/**
 * Convenience wrapper: classify a free-form reason string, then check whether
 * the resulting code is a skip-class outcome. Replaces the duplicated
 * `isLegitSkipReason` / `isCompactionSkipReason` substring helpers.
 */
export declare function isCompactionSkipReason(reason?: string): boolean;
export declare function resolveCompactionFailureReason(params: {
    reason: string;
    safeguardCancelReason?: string | null;
}): string;
export declare function classifyCompactionReason(reason?: string): CompactionReasonCode;
export declare function formatUnknownCompactionReasonDetail(reason?: string): string | undefined;
