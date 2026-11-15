import type { Static } from "typebox";
import {
  ErrorCodes,
  SETUP_ADMISSION_BUSY_ERROR_CODE,
  TASK_WORKTREE_SOURCE_REQUIRED_ERROR_CODE,
  WIZARD_NOT_FOUND_ERROR_CODE,
} from "./gateway-error-codes.js";
import { MISSING_SCOPE_ERROR_CODE, type MissingScopeErrorDetails } from "./missing-scope-error.js";
import { asProtocolRecord } from "./protocol-value-normalization.js";
import type * as ErrorSchemas from "./schema/error-codes.js";

export { ErrorCodes, type ErrorCode } from "./gateway-error-codes.js";
export {
  readMissingScopeError,
  readMissingScopeErrorDetails,
  type MissingScopeErrorDetails,
} from "./missing-scope-error.js";

/** Display projection for an assistant failure without visible reply content. */
export const GATEWAY_ASSISTANT_ERROR_FALLBACK_TEXT =
  "The agent run failed before producing a reply.";

const CRON_JOB_NOT_FOUND = "CRON_JOB_NOT_FOUND";
const MCP_APP_VIEW_EXPIRED = "MCP_APP_VIEW_EXPIRED";
const GITHUB_PUBLICATION_SELECTION_REJECTED = "GITHUB_PUBLICATION_SELECTION_REJECTED";
const CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED = "CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED";
const TEMPLATE_REVIEW_REQUIRED = "TEMPLATE_REVIEW_REQUIRED";

/** Stable discriminants for structured method-level failures. */
export const GatewayErrorDetailCodes = {
  CRON_JOB_NOT_FOUND,
  MISSING_SCOPE: MISSING_SCOPE_ERROR_CODE,
  MCP_APP_VIEW_EXPIRED,
  OUTBOUND_DELIVERY_QUEUED: "OUTBOUND_DELIVERY_QUEUED",
  USER_PREFS_LIMIT_EXCEEDED: "USER_PREFS_LIMIT_EXCEEDED",
  SESSION_COMPANION_BUSY: "SESSION_COMPANION_BUSY",
  PROJECT_CLONE_FAILED: "PROJECT_CLONE_FAILED",
  UNKNOWN_AGENT_ID: "UNKNOWN_AGENT_ID",
  WIZARD_NOT_FOUND: WIZARD_NOT_FOUND_ERROR_CODE,
  SETUP_ADMISSION_BUSY: SETUP_ADMISSION_BUSY_ERROR_CODE,
  GITHUB_PUBLICATION_SELECTION_REJECTED,
  SESSION_WORKSPACE_RECOVERY_REQUIRED: "SESSION_WORKSPACE_RECOVERY_REQUIRED",
  TASK_WORKTREE_SOURCE_REQUIRED: TASK_WORKTREE_SOURCE_REQUIRED_ERROR_CODE,
  TASK_HISTORY_PREVIEW_CAPACITY: "TASK_HISTORY_PREVIEW_CAPACITY",
  CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED,
  TEMPLATE_REVIEW_REQUIRED,
  PENDING_INPUT_NOT_RETIRED: "PENDING_INPUT_NOT_RETIRED",
  OPENCLAW_CONFIG_READONLY: "OPENCLAW_CONFIG_READONLY",
} as const;

/** Missing cron automation identified by its exact store key. */
export type CronJobNotFoundErrorDetails = Static<
  typeof ErrorSchemas.CronJobNotFoundErrorDetailsSchema
>;

export type McpAppViewExpiredErrorDetails = Static<
  typeof ErrorSchemas.McpAppViewExpiredErrorDetailsSchema
>;

export type OutboundDeliveryQueuedErrorDetails = Static<
  typeof ErrorSchemas.OutboundDeliveryQueuedErrorDetailsSchema
>;

/** Per-profile preference quota details returned by users.prefs.set. */
export type UserPrefsLimitExceededErrorDetails = Static<
  typeof ErrorSchemas.UserPrefsLimitExceededErrorDetailsSchema
>;

/** Unknown agent details carried by agent-scoped method validation failures. */
export type UnknownAgentIdErrorDetails = Static<
  typeof ErrorSchemas.UnknownAgentIdErrorDetailsSchema
>;

/** Setup rejected before its task or wizard session was admitted. */
export type SetupAdmissionBusyErrorDetails = Static<
  typeof ErrorSchemas.SetupAdmissionBusyErrorDetailsSchema
>;

/** This invocation rejected its selection before admission; earlier calls may still be pending. */
export type GitHubPublicationSelectionRejectedErrorDetails = Static<
  typeof ErrorSchemas.GitHubPublicationSelectionRejectedErrorDetailsSchema
>;

/** Missing or expired process-local setup wizard session. */
export type WizardNotFoundErrorDetails = Static<
  typeof ErrorSchemas.WizardNotFoundErrorDetailsSchema
>;

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
export type SessionWorkspaceRecoveryRequiredErrorDetails = Static<
  typeof ErrorSchemas.SessionWorkspaceRecoveryRequiredErrorDetailsSchema
>;

/** Structured details emitted by method-level failures. */
export type TaskWorktreeSourceRequiredErrorDetails = Static<
  typeof ErrorSchemas.TaskWorktreeSourceRequiredErrorDetailsSchema
>;

export type ClawHubRiskAcknowledgementRequiredErrorDetails = Static<
  typeof ErrorSchemas.ClawHubRiskAcknowledgementRequiredErrorDetailsSchema
>;

export type TemplateReviewRequiredErrorDetails = Static<
  typeof ErrorSchemas.TemplateReviewRequiredErrorDetailsSchema
>;

/** Requested pending inputs that are still queued or held by a settling turn. */
export type PendingInputNotRetiredErrorDetails = Static<
  typeof ErrorSchemas.PendingInputNotRetiredErrorDetailsSchema
>;

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
  | ClawHubRiskAcknowledgementRequiredErrorDetails
  | TemplateReviewRequiredErrorDetails
  | PendingInputNotRetiredErrorDetails
  | { code: typeof GatewayErrorDetailCodes.TASK_HISTORY_PREVIEW_CAPACITY }
  | { code: typeof GatewayErrorDetailCodes.OPENCLAW_CONFIG_READONLY };

export function readClawHubRiskAcknowledgementRequiredError(
  error: unknown,
): ClawHubRiskAcknowledgementRequiredErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  const warning = typeof details?.warning === "string" ? details.warning.trim() : "";
  return record?.code === ErrorCodes.INVALID_REQUEST &&
    details?.code === CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED &&
    warning
    ? { code: CLAWHUB_RISK_ACKNOWLEDGEMENT_REQUIRED, warning }
    : null;
}

export function readTemplateReviewRequiredError(
  error: unknown,
): TemplateReviewRequiredErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  return record?.code === ErrorCodes.INVALID_REQUEST &&
    details?.code === TEMPLATE_REVIEW_REQUIRED &&
    (details.kind === "plugin" || details.kind === "skill")
    ? { code: TEMPLATE_REVIEW_REQUIRED, kind: details.kind }
    : null;
}

export function readGitHubPublicationSelectionRejectedError(
  error: unknown,
): GitHubPublicationSelectionRejectedErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  return record?.code === ErrorCodes.UNAVAILABLE &&
    details?.code === GITHUB_PUBLICATION_SELECTION_REJECTED &&
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
  if (details?.code !== CRON_JOB_NOT_FOUND) {
    return null;
  }
  const jobId = typeof details.jobId === "string" ? details.jobId.trim() : "";
  return jobId ? { code: CRON_JOB_NOT_FOUND, jobId } : null;
}

export function isMcpAppViewExpiredError(error: unknown): boolean {
  const record = asProtocolRecord(error);
  return asProtocolRecord(record?.details)?.code === MCP_APP_VIEW_EXPIRED;
}
