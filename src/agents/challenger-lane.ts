/**
 * Challenger lane scaffolding for OpenClaw control plane.
 *
 * The challenger lane provides an explicit second-opinion path
 * that is only invoked under specific trigger conditions.
 * This is scaffolded behind a config flag and is NOT enabled by default.
 */

/** Conditions that can trigger challenger invocation. */
export type ChallengerTrigger =
  | "revise_loop_exceeded"
  | "architecture_conflict"
  | "migration_risk"
  | "root_cause_ambiguity"
  | "user_requested";

/** What the challenger returns. */
export type ChallengerResponseKind =
  | "counter_brief"
  | "alternate_patch_plan"
  | "root_cause_memo"
  | "explicit_disagreement";

/** Full challenger outcome. */
export interface ChallengerOutcome {
  trigger: ChallengerTrigger;
  responseKind: ChallengerResponseKind;
  /** The challenger's analysis/recommendation. */
  content: string;
  /** Model used for the challenger run. */
  challengerModel?: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Duration in milliseconds. */
  durationMs?: number;
}

/** Challenger lane configuration. */
export interface ChallengerLaneConfig {
  enabled: boolean;
  /** Maximum number of challenger invocations per task. */
  maxInvocationsPerTask?: number;
}

const DEFAULT_CONFIG: ChallengerLaneConfig = {
  enabled: false,
  maxInvocationsPerTask: 1,
};

/**
 * Check whether the challenger lane is enabled.
 */
export function isChallengerEnabled(config?: Partial<ChallengerLaneConfig>): boolean {
  return config?.enabled ?? DEFAULT_CONFIG.enabled;
}

/**
 * Determine whether a challenger should be invoked based on trigger conditions.
 */
export function shouldInvokeChallenger(params: {
  config?: Partial<ChallengerLaneConfig>;
  trigger: ChallengerTrigger;
  reviseCount?: number;
  priorChallengerCount?: number;
}): { invoke: boolean; reason: string } {
  if (!isChallengerEnabled(params.config)) {
    return { invoke: false, reason: "challenger_lane_disabled" };
  }

  const maxInvocations =
    params.config?.maxInvocationsPerTask ?? DEFAULT_CONFIG.maxInvocationsPerTask ?? 1;

  if ((params.priorChallengerCount ?? 0) >= maxInvocations) {
    return { invoke: false, reason: "max_invocations_reached" };
  }

  switch (params.trigger) {
    case "revise_loop_exceeded":
      if ((params.reviseCount ?? 0) < 2) {
        return { invoke: false, reason: "revise_count_below_threshold" };
      }
      return { invoke: true, reason: "revise_loop_exceeded_threshold" };

    case "architecture_conflict":
    case "migration_risk":
    case "root_cause_ambiguity":
    case "user_requested":
      return { invoke: true, reason: params.trigger };

    default:
      return { invoke: false, reason: "unknown_trigger" };
  }
}
