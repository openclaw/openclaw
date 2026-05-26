/**
 * Structured decision returned by gate/policy hooks.
 * Core is outcome-agnostic — it handles the mechanics of each outcome
 * without knowing *why* the decision was made.
 */
export type HookDecision = HookDecisionPass | HookDecisionBlock;
/** Content is fine. Proceed normally. */
export type HookDecisionPass = {
    outcome: "pass";
};
/** Prefix for user-facing replacement messages when a `block` decision stops a request. */
export declare const BLOCK_MESSAGE_PREFIX = "Your message could not be sent";
/**
 * Content is blocked. `reason` is internal plugin-local detail; core must not log,
 * persist, broadcast, or expose it verbatim. `message` is user-facing detail.
 */
export type HookDecisionBlock = {
    outcome: "block";
    /** Internal plugin-local reason. Do not log, persist, broadcast, or expose verbatim. */
    reason: string;
    /** Optional user-facing detail included in the block response envelope. */
    message?: string;
    /** Plugin-defined category for analytics (e.g. "violence", "pii", "cost_limit"). */
    category?: string;
    /** Opaque metadata for the plugin's own use. Core does not interpret it. */
    metadata?: Record<string, unknown>;
};
export declare function resolveBlockMessage(decision: HookDecisionBlock, params?: {
    blockedBy?: string;
}): string;
/** Outcome severity for most-restrictive-wins merging. Higher = more restrictive. */
export declare const HOOK_DECISION_SEVERITY: Record<HookDecision["outcome"], number>;
/**
 * Merge two HookDecisions using most-restrictive-wins semantics.
 * `block > pass`
 */
export declare function mergeHookDecisions(a: HookDecision | undefined, b: HookDecision): HookDecision;
/**
 * Type guard: does this object look like a HookDecision (has `outcome` field)?
 */
export declare function isHookDecision(value: unknown): value is HookDecision;
/** Outcomes valid for input gates (before_agent_run). */
export type InputGateDecision = HookDecisionPass | HookDecisionBlock;
/**
 * A gate hook decision paired with the pluginId that produced it.
 * Returned by gate hook runners so callers can
 * attribute blocked entries and audit events to the originating plugin.
 */
export type GateHookResult<TDecision extends HookDecision = HookDecision> = {
    decision: TDecision;
    pluginId: string;
};
