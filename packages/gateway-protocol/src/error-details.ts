export * from "./agent-runtime-restriction-error-details.js";
export * from "./capability-consent-error-details.js";
export * from "./clawhub-trust-error-details.js";
export * from "./install-policy-warning-error-details.js";
export * from "./system-agent-error-details.js";
export {
  ErrorCodes,
  GatewayErrorDetailCodes,
  isMcpAppViewExpiredError,
  readCronJobNotFoundError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
} from "./gateway-error-details.js";
export type {
  CronJobNotFoundErrorDetails,
  GatewayErrorDetails,
  McpAppViewExpiredErrorDetails,
  OutboundDeliveryQueuedErrorDetails,
  MissingScopeErrorDetails,
  UserPrefsLimitExceededErrorDetails,
  ProjectCloneErrorDetails,
  ProjectCloneFailureCause,
  WizardNotFoundErrorDetails,
  SetupAdmissionBusyErrorDetails,
  SessionWorkspaceRecoveryRequiredErrorDetails,
} from "./gateway-error-details.js";
export {
  CronJobNotFoundErrorDetailsSchema,
  GatewayErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  OutboundDeliveryQueuedErrorDetailsSchema,
  UserPrefsLimitExceededErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
  WizardNotFoundErrorDetailsSchema,
  SetupAdmissionBusyErrorDetailsSchema,
  SessionWorkspaceRecoveryRequiredErrorDetailsSchema,
  buildMissingScopeErrorDetails,
  errorShape,
  missingScopeErrorShape,
} from "./schema/error-codes.js";

export { readSessionWorkspaceRecoveryRequiredError } from "./session-workspace-recovery-error-details.js";
