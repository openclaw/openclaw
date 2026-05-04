export type PreemptiveCompactionRoute =
  | "fits"
  | "compact_only"
  | "truncate_tool_results_only"
  | "irreducible_overflow"
  | "compact_then_truncate";
