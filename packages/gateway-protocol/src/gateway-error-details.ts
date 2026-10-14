import { asProtocolRecord } from "./protocol-value-normalization.js";
import type { SessionMoveExpectedSource } from "./schema/session-placement.js";

/** Display projection for an assistant failure without visible reply content. */
export const GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT =
  "The agent run failed before producing a reply.";

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

/** Stable discriminants for structured method-level failures. */
export const GatewayErrorDetailCodes = {
  CRON_JOB_NOT_FOUND: "CRON_JOB_NOT_FOUND",
  MISSING_SCOPE: "MISSING_SCOPE",
  MCP_APP_VIEW_EXPIRED: "MCP_APP_VIEW_EXPIRED",
  OUTBOUND_DELIVERY_QUEUED: "OUTBOUND_DELIVERY_QUEUED",
  USER_PREFS_LIMIT_EXCEEDED: "USER_PREFS_LIMIT_EXCEEDED",
  SESSION_COMPANION_BUSY: "SESSION_COMPANION_BUSY",
  PROJECT_CLONE_FAILED: "PROJECT_CLONE_FAILED",
  UNKNOWN_AGENT_ID: "UNKNOWN_AGENT_ID",
  WIZARD_NOT_FOUND: "WIZARD_NOT_FOUND",
  SETUP_ADMISSION_BUSY: "SETUP_ADMISSION_BUSY",
  GITHUB_PUBLICATION_SELECTION_REJECTED: "GITHUB_PUBLICATION_SELECTION_REJECTED",
  SESSION_WORKSPACE_RECOVERY_REQUIRED: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
  TASK_WORKTREE_SOURCE_REQUIRED: "TASK_WORKTREE_SOURCE_REQUIRED",
  TASK_HISTORY_PREVIEW_CAPACITY: "TASK_HISTORY_PREVIEW_CAPACITY",
} as const;

/** Missing cron automation identified by its exact store key. */
export type CronJobNotFoundErrorDetails = {
  code: typeof GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND;
  jobId: string;
};

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export type MissingScopeErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MISSING_SCOPE;
  missingScope: string;
  requiredScopes: string[];
};

export type McpAppViewExpiredErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
};

export type OutboundDeliveryQueuedErrorDetails = {
  code: typeof GatewayErrorDetailCodes.OUTBOUND_DELIVERY_QUEUED;
};

/** Per-profile preference quota details returned by users.prefs.set. */
export type UserPrefsLimitExceededErrorDetails = {
  code: typeof GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED;
  limit: number;
  currentCount: number;
};

/** Unknown agent details carried by agent-scoped method validation failures. */
export type UnknownAgentIdErrorDetails = {
  code: typeof GatewayErrorDetailCodes.UNKNOWN_AGENT_ID;
  agentId: string;
};

/** Setup rejected before its task or wizard session was admitted. */
export type SetupAdmissionBusyErrorDetails = {
  code: typeof GatewayErrorDetailCodes.SETUP_ADMISSION_BUSY;
};

/** This invocation rejected its selection before admission; earlier calls may still be pending. */
export type GitHubPublicationSelectionRejectedErrorDetails = {
  code: typeof GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED;
  idempotencyKey: string;
};

/** Missing or expired process-local setup wizard session. */
export type WizardNotFoundErrorDetails = {
  code: typeof GatewayErrorDetailCodes.WIZARD_NOT_FOUND;
};

export type ProjectCloneFailureCause =
  | "invalid_url"
  | "auth_required"
  | "not_found"
  | "network"
  | "target_exists"
  | "clone_failed";

export type ProjectCloneErrorDetails = {
  code: typeof GatewayErrorDetailCodes.PROJECT_CLONE_FAILED;
  cause: ProjectCloneFailureCause;
};

/** Exact retained workspace owner that must be recovered or explicitly abandoned. */
export type SessionWorkspaceRecoveryRequiredErrorDetails = {
  code: typeof GatewayErrorDetailCodes.SESSION_WORKSPACE_RECOVERY_REQUIRED;
  cause: "device_offline";
  recoveryAction: "continue_on_gateway";
  sessionId: string;
  source: SessionMoveExpectedSource;
};

/** Structured details emitted by method-level failures. */
export type TaskWorktreeSourceRequiredErrorDetails = {
  code: typeof GatewayErrorDetailCodes.TASK_WORKTREE_SOURCE_REQUIRED;
  cwd: string;
};

/** Structured details emitted by method-level failures. */
export type GatewayErrorDetails =
  | CronJobNotFoundErrorDetails
  | MissingScopeErrorDetails
  | McpAppViewExpiredErrorDetails
  | OutboundDeliveryQueuedErrorDetails
  | UserPrefsLimitExceededErrorDetails
  | ProjectCloneErrorDetails
  | UnknownAgentIdErrorDetails
  | WizardNotFoundErrorDetails
  | SetupAdmissionBusyErrorDetails
  | GitHubPublicationSelectionRejectedErrorDetails
  | SessionWorkspaceRecoveryRequiredErrorDetails
  | TaskWorktreeSourceRequiredErrorDetails
  | { code: typeof GatewayErrorDetailCodes.TASK_HISTORY_PREVIEW_CAPACITY };

const LEGACY_MISSING_SCOPE_PATTERN = /\bmissing scope:\s*([a-z0-9._-]+)/i;

export function readGitHubPublicationSelectionRejectedError(
  error: unknown,
): GitHubPublicationSelectionRejectedErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  return record?.code === ErrorCodes.UNAVAILABLE &&
    details?.code === GatewayErrorDetailCodes.GITHUB_PUBLICATION_SELECTION_REJECTED &&
    Object.keys(details).length === 2 &&
    typeof details.idempotencyKey === "string" &&
    details.idempotencyKey.length > 0
    ? { code: details.code, idempotencyKey: details.idempotencyKey }
    : null;
}

/** Reads a typed cron lookup miss without parsing operator-facing prose. */
export function readCronJobNotFoundError(error: unknown): CronJobNotFoundErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  if (details?.code !== GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND) {
    return null;
  }
  const jobId = typeof details.jobId === "string" ? details.jobId.trim() : "";
  return jobId ? { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId } : null;
}

/** Reads validated missing-scope details from an untrusted protocol payload. */
export function readMissingScopeErrorDetails(details: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(details);
  if (record?.code !== GatewayErrorDetailCodes.MISSING_SCOPE) {
    return null;
  }
  const missingScope = typeof record.missingScope === "string" ? record.missingScope.trim() : "";
  const requiredScopes = Array.isArray(record.requiredScopes)
    ? record.requiredScopes.map((scope) => (typeof scope === "string" ? scope.trim() : ""))
    : [];
  if (!missingScope || requiredScopes.length === 0 || requiredScopes.some((scope) => !scope)) {
    return null;
  }
  return {
    code: GatewayErrorDetailCodes.MISSING_SCOPE,
    missingScope,
    requiredScopes,
  };
}

export function isMcpAppViewExpiredError(error: unknown): boolean {
  const record = asProtocolRecord(error);
  return asProtocolRecord(record?.details)?.code === GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
}

/**
 * Reads a method-level missing-scope failure, preferring structured details.
 * The message fallback keeps clients compatible with gateways predating structured details.
 */
export function readMissingScopeError(error: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(error);
  if (!record) {
    return null;
  }
  const structured = readMissingScopeErrorDetails(record.details);
  if (structured) {
    return structured;
  }
  const code =
    typeof record.gatewayCode === "string"
      ? record.gatewayCode
      : typeof record.code === "string"
        ? record.code
        : "";
  if (code !== ErrorCodes.FORBIDDEN && code !== ErrorCodes.INVALID_REQUEST) {
    return null;
  }
  const message = typeof record.message === "string" ? record.message : "";
  const missingScope = message.match(LEGACY_MISSING_SCOPE_PATTERN)?.[1];
  return missingScope
    ? {
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope,
        requiredScopes: [missingScope],
      }
    : null;
}
