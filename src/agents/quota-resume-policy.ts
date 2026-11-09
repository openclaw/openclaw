/**
 * Automatic quota-resume policy.
 *
 * Pure decisions for the Gateway service that wakes sessions whose last run was
 * suspended by a provider usage limit. The runtime owns I/O; this module only
 * decides whether a suspended session should be launched, waited on, or skipped.
 */
import type { QuotaSuspension, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Scan cadence for the Gateway resume service. */
export const QUOTA_RESUME_SCAN_INTERVAL_MS = 60_000;
/** Delay before the first scan so Gateway startup finishes publishing ready state. */
export const QUOTA_RESUME_INITIAL_DELAY_MS = 10_000;
/** Bound automatic retries; a human can always continue the session manually. */
export const QUOTA_RESUME_MAX_ATTEMPTS = 6;
/** Margin after a provider-reported reset so the first request lands inside the new window. */
export const QUOTA_RESUME_COOLDOWN_MARGIN_MS = 15_000;
/** Fallback wait when the provider reports no reset time. Doubles per attempt. */
export const QUOTA_RESUME_DEFAULT_RETRY_MS = 30 * 60 * 1000;
export const QUOTA_RESUME_MAX_RETRY_MS = 6 * 60 * 60 * 1000;
/** A launch older than this with no run started is treated as lost and retried. */
export const QUOTA_RESUME_LAUNCH_GRACE_MS = 10 * 60 * 1000;
/** Ignore cooldown expiries further out than this; they are not usage-window resets. */
export const QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * A suspension whose resume time passed longer ago than this is abandoned, not
 * resumed: the work is stale and, after an upgrade, historical markers in every
 * store would otherwise all launch on the first scan.
 */
export const QUOTA_RESUME_OVERDUE_LIMIT_MS = 24 * 60 * 60 * 1000;

export type QuotaResumeSkipReason =
  | "not_suspended"
  | "not_quota"
  | "aborted"
  | "superseded"
  | "expired"
  | "run_active"
  | "attempts_exhausted"
  | "launch_in_flight";

export type QuotaResumeDecision =
  | { action: "launch"; attempt: number }
  | { action: "wait"; resumeAtMs: number }
  | { action: "skip"; reason: QuotaResumeSkipReason };

export type QuotaResumeCandidateEntry = Pick<
  SessionEntry,
  "quotaSuspension" | "abortedLastRun" | "lastInteractionAt" | "sessionId"
>;

export type QuotaResumeSettings = {
  enabled: boolean;
  maxAttempts: number;
};

/** Effective `agents.defaults.quotaResume` settings with defaults applied. */
export function resolveQuotaResumeSettings(cfg: OpenClawConfig | undefined): QuotaResumeSettings {
  const raw = cfg?.agents?.defaults?.quotaResume;
  const maxAttempts = raw?.maxAttempts;
  return {
    enabled: raw?.enabled !== false,
    maxAttempts:
      typeof maxAttempts === "number" && Number.isFinite(maxAttempts) && maxAttempts >= 1
        ? Math.floor(maxAttempts)
        : QUOTA_RESUME_MAX_ATTEMPTS,
  };
}

export function resolveQuotaResumeAttempts(suspension: QuotaSuspension | undefined): number {
  const attempts = suspension?.autoResume?.attempts;
  return typeof attempts === "number" && Number.isFinite(attempts) && attempts > 0
    ? Math.floor(attempts)
    : 0;
}

/**
 * Fallback retry delay when no provider reset time is known; grows per completed
 * attempt. `attempts` is the number already made, so the first retry waits the base delay.
 */
export function resolveQuotaResumeRetryDelayMs(attempts: number): number {
  const exponent = Math.max(0, Math.min(attempts, 10));
  return Math.min(QUOTA_RESUME_DEFAULT_RETRY_MS * 2 ** exponent, QUOTA_RESUME_MAX_RETRY_MS);
}

/**
 * Live-entry checks that must hold both when a candidate is selected and again
 * inside the store transaction that marks it `resuming`.
 */
export function resolveQuotaResumeBlocker(
  entry: Pick<QuotaResumeCandidateEntry, "abortedLastRun" | "lastInteractionAt">,
  suspension: Pick<QuotaSuspension, "suspendedAt">,
): Extract<QuotaResumeSkipReason, "aborted" | "superseded"> | null {
  // The operator stopped the run after it was parked; never restart it behind their back.
  if (entry.abortedLastRun) {
    return "aborted";
  }
  // A newer human turn means the session already moved on; the lazy maintenance
  // path owns the stale marker from here.
  if ((entry.lastInteractionAt ?? 0) > suspension.suspendedAt) {
    return "superseded";
  }
  return null;
}

/**
 * Convert a provider cooldown expiry into a suspension TTL. Returns undefined for
 * missing, past, or implausibly distant expiries so the default TTL applies.
 */
export function resolveQuotaSuspensionTtlMsFromCooldownExpiry(
  expiryMs: number | null | undefined,
  now: number,
): number | undefined {
  if (typeof expiryMs !== "number" || !Number.isFinite(expiryMs)) {
    return undefined;
  }
  const ttlMs = expiryMs + QUOTA_RESUME_COOLDOWN_MARGIN_MS - now;
  if (ttlMs <= 0 || ttlMs > QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS) {
    return undefined;
  }
  return Math.ceil(ttlMs);
}

/** Earliest time the session may be woken, honoring both the stored TTL and live provider cooldown. */
export function resolveQuotaResumeAtMs(params: {
  suspension: QuotaSuspension;
  now: number;
  providerCooldownUntilMs?: number | null;
}): number {
  const { suspension } = params;
  const attempts = resolveQuotaResumeAttempts(suspension);
  const storedResumeAt =
    suspension.autoResume?.nextAttemptAt ??
    suspension.expectedResumeBy ??
    suspension.suspendedAt + resolveQuotaResumeRetryDelayMs(attempts);
  let resumeAt = storedResumeAt;
  const cooldownUntil = params.providerCooldownUntilMs;
  if (
    typeof cooldownUntil === "number" &&
    Number.isFinite(cooldownUntil) &&
    cooldownUntil > params.now &&
    cooldownUntil - params.now <= QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS
  ) {
    resumeAt = Math.max(resumeAt, cooldownUntil + QUOTA_RESUME_COOLDOWN_MARGIN_MS);
  }
  return resumeAt;
}

export function resolveQuotaResumeDecision(params: {
  entry: QuotaResumeCandidateEntry;
  now: number;
  runActive: boolean;
  providerCooldownUntilMs?: number | null;
  /** Attempt budget; defaults to QUOTA_RESUME_MAX_ATTEMPTS. */
  maxAttempts?: number;
}): QuotaResumeDecision {
  const suspension = params.entry.quotaSuspension;
  if (!suspension) {
    return { action: "skip", reason: "not_suspended" };
  }
  if (suspension.state !== "suspended" && suspension.state !== "resuming") {
    return { action: "skip", reason: "not_suspended" };
  }
  if (suspension.reason !== "quota_exhausted") {
    return { action: "skip", reason: "not_quota" };
  }
  const blocker = resolveQuotaResumeBlocker(params.entry, suspension);
  if (blocker) {
    return { action: "skip", reason: blocker };
  }
  const attempts = resolveQuotaResumeAttempts(suspension);
  if (attempts >= (params.maxAttempts ?? QUOTA_RESUME_MAX_ATTEMPTS)) {
    return { action: "skip", reason: "attempts_exhausted" };
  }
  const lastAttemptAt = suspension.autoResume?.lastAttemptAt;
  if (
    suspension.state === "resuming" &&
    typeof lastAttemptAt === "number" &&
    params.now - lastAttemptAt < QUOTA_RESUME_LAUNCH_GRACE_MS
  ) {
    return { action: "skip", reason: "launch_in_flight" };
  }
  const resumeAtMs = resolveQuotaResumeAtMs({
    suspension,
    now: params.now,
    providerCooldownUntilMs: params.providerCooldownUntilMs,
  });
  if (params.now < resumeAtMs) {
    return { action: "wait", resumeAtMs };
  }
  if (params.now - resumeAtMs > QUOTA_RESUME_OVERDUE_LIMIT_MS) {
    return { action: "skip", reason: "expired" };
  }
  if (params.runActive) {
    return { action: "skip", reason: "run_active" };
  }
  return { action: "launch", attempt: attempts + 1 };
}

/** Prompt body for the Gateway-authored continuation turn. */
export const QUOTA_RESUME_CONTINUATION_TEXT =
  "Your model quota has been restored after a provider usage limit interrupted the previous turn. " +
  "Continue the interrupted work from the transcript. Before repeating any tool action, check whether it already completed. " +
  "If nothing remains, reply briefly that the task is complete.";
