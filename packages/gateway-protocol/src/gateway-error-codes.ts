/** Gateway JSON-RPC style error codes shared by clients and server handlers. */
export const ErrorCodes = {
  /** @deprecated Retained for source compatibility; no current server emitter. */
  NOT_LINKED: "NOT_LINKED",
  /** Device exists but still needs an explicit pairing approval. */
  NOT_PAIRED: "NOT_PAIRED",
  /** @deprecated Retained for source compatibility; no current server emitter. */
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  /** Request payload failed protocol validation or method preconditions. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** Authenticated caller lacks permission for the requested operation. */
  FORBIDDEN: "FORBIDDEN",
  /** Approval resolution referenced a missing or expired approval request. */
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  /** Gateway service or required backend is temporarily unavailable. */
  UNAVAILABLE: "UNAVAILABLE",
} as const;

/** Closed set of canonical gateway error code strings. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// Leaf readers can use one discriminant without retaining the complete detail registry.
export const WIZARD_NOT_FOUND_ERROR_CODE = "WIZARD_NOT_FOUND";
export const SETUP_ADMISSION_BUSY_ERROR_CODE = "SETUP_ADMISSION_BUSY";
export const TASK_WORKTREE_SOURCE_REQUIRED_ERROR_CODE = "TASK_WORKTREE_SOURCE_REQUIRED";
