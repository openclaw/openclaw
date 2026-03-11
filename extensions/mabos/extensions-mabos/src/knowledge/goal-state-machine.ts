/**
 * Goal State Machine — Defines lifecycle states and valid transitions for goals.
 *
 * States: pending → active → in_progress → achieved/failed/suspended/abandoned
 *
 * Terminal states: achieved, abandoned
 * Failed and suspended goals can be retried (transitioned back to active).
 */

export type GoalState =
  | "pending"
  | "active"
  | "in_progress"
  | "achieved"
  | "failed"
  | "suspended"
  | "abandoned";

const VALID_TRANSITIONS: Record<GoalState, GoalState[]> = {
  pending: ["active", "abandoned"],
  active: ["in_progress", "suspended", "abandoned"],
  in_progress: ["achieved", "failed", "suspended", "abandoned"],
  achieved: [], // terminal
  failed: ["active", "abandoned"], // allow retry
  suspended: ["active", "abandoned"],
  abandoned: [], // terminal
};

const TERMINAL_STATES: Set<GoalState> = new Set(["achieved", "abandoned"]);

/**
 * Check whether a transition from one state to another is valid.
 */
export function canTransition(from: GoalState, to: GoalState): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate a transition, throwing an error if invalid.
 */
export function validateTransition(from: GoalState, to: GoalState): void {
  if (!canTransition(from, to)) {
    const allowed = VALID_TRANSITIONS[from] ?? [];
    throw new Error(
      `Invalid goal state transition: ${from} → ${to}. ` +
        `Allowed transitions from "${from}": [${allowed.join(", ")}]`,
    );
  }
}

/**
 * Check whether a state is terminal (no further transitions allowed).
 */
export function isTerminalState(state: GoalState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Get all valid next states from the given state.
 */
export function getValidTransitions(state: GoalState): GoalState[] {
  return VALID_TRANSITIONS[state] ?? [];
}

/**
 * State display metadata for UI rendering.
 */
export const GOAL_STATE_COLORS: Record<GoalState, string> = {
  pending: "var(--text-muted, #6b7280)",
  active: "var(--accent-green, #22c55e)",
  in_progress: "var(--accent-blue, #3b82f6)",
  achieved: "var(--accent-green, #22c55e)",
  failed: "var(--accent-red, #ef4444)",
  suspended: "var(--accent-orange, #f59e0b)",
  abandoned: "var(--text-muted, #6b7280)",
};

export const GOAL_STATE_LABELS: Record<GoalState, string> = {
  pending: "Pending",
  active: "Active",
  in_progress: "In Progress",
  achieved: "Achieved",
  failed: "Failed",
  suspended: "Suspended",
  abandoned: "Abandoned",
};
