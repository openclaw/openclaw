/**
 * Route chosen by the pre-prompt context budget gate.
 *
 * Non-`fits` routes are user-visible enough to flow into mid-turn precheck
 * payloads and attempt results, so keep these string literals stable unless
 * every consumer and diagnostic surface is updated together.
 */
export type PreemptiveCompactionRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "compact_then_truncate";
