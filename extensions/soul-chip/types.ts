// ---------------------------------------------------------------------------
// soul-chip types
// ---------------------------------------------------------------------------

/** Plugin configuration. */
export type SoulChipConfig = {
  /** Keyword that triggers pause/meditation mode */
  pauseKeyword: string;
  /** Keyword that resumes from meditation mode */
  resumeKeyword: string;
  /** Hook priority (lower = earlier, soul should be first) */
  injectPriority: number;
};

/** Pause state persisted to disk. */
export type PauseState = {
  paused: boolean;
  pausedAt: string | null;
  pausedBy: string | null;
  reason: string | null;
};

/** Soul layer names, matching the seven files in workspace/soul/. */
export type SoulLayer =
  | "worldview"
  | "identity"
  | "values"
  | "boundaries"
  | "persona"
  | "anchors"
  | "direction";

/** All seven layers combined into a single snapshot. */
export type SoulSnapshot = {
  worldview: string | null;
  identity: string | null;
  values: string | null;
  boundaries: string | null;
  persona: string | null;
  anchors: string | null;
  direction: string | null;
};
