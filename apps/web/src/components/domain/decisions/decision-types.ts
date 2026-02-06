/**
 * Decision Audit Log types.
 *
 * Extends the core DecisionRecord with UI-specific types for rendering
 * the decision audit log timeline.
 */

export type DecisionOutcome = "approved" | "rejected" | "expired" | "pending";

export interface DecisionAuditEntry {
  /** Unique decision identifier. */
  id: string;
  /** When the decision was created. */
  timestamp: number;
  /** Decision title displayed to user. */
  title: string;
  /** Question/prompt for the user. */
  question: string;
  /** Decision type. */
  type: "binary" | "choice" | "text" | "confirmation";
  /** Outcome of the decision. */
  outcome: DecisionOutcome;
  /** Who responded (if answered). */
  respondedBy?: string;
  /** When responded. */
  respondedAt?: number;
  /** The chosen response value. */
  responseValue?: string;
  /** Associated goal ID. */
  goalId?: string;
  /** Associated goal title for display. */
  goalTitle?: string;
  /** Agent that requested the decision. */
  agentId?: string;
  /** Session key context. */
  sessionKey?: string;
  /** Available options (for choice/binary). */
  options?: Array<{ label: string; value: string; style?: string }>;
  /** Reasoning chain / context for why this decision was needed. */
  reasoning?: string;
  /** Actions dispatched as a result of this decision. */
  dispatchedActions?: string[];
}

export type DecisionSortField = "timestamp" | "outcome" | "type";
export type DecisionSortOrder = "asc" | "desc";

export interface DecisionFilterState {
  outcome: DecisionOutcome | "all";
  type: string;
  goalId: string;
  search: string;
  dateRange: "all" | "today" | "week" | "month";
}
