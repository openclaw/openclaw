export const UPDATE_RUN_DRIVER_LIMIT = 8;

export const UPDATE_RUN_PHASES = [
  "requested",
  "staging",
  "validating",
  "repairing",
  "activating",
  "restarting",
  "verifying",
  "finished",
] as const;
export const UPDATE_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "rolled-back",
  "skipped",
] as const;
export const UPDATE_RUN_TRIGGERS = [
  "chat",
  "control-ui",
  "cli",
  "campaign",
  "mac-app",
  "api",
] as const;
export const UPDATE_RUN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "skipped",
] as const;

/** Why a finished update attempt ended. A closed set, so reports never redact it. */
export const UPDATE_RUN_CAUSES = [
  "none",
  "node-unsupported",
  "git-unsupported",
  "disk-full",
  "permission-denied",
  "network",
  "config-invalid",
  "install-failed",
  "state-migration-failed",
  "plugin-failed",
  "service-failed",
  "interrupted",
  "refused",
  "unknown",
] as const;

export const UPDATE_NPM_ERROR_CODES = [
  "ETARGET",
  "E404",
  "EINTEGRITY",
  "EACCES",
  "ENOTEMPTY",
  "ENOSPC",
  "ECONNRESET",
  "ETIMEDOUT",
  "EBUSY",
  "unknown",
] as const;
