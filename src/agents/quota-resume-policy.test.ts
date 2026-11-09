import { describe, expect, it } from "vitest";
import type { QuotaSuspension } from "../config/sessions/types.js";
import {
  QUOTA_RESUME_COOLDOWN_MARGIN_MS,
  QUOTA_RESUME_DEFAULT_RETRY_MS,
  QUOTA_RESUME_LAUNCH_GRACE_MS,
  QUOTA_RESUME_MAX_ATTEMPTS,
  QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS,
  QUOTA_RESUME_MAX_RETRY_MS,
  resolveQuotaResumeAtMs,
  resolveQuotaResumeDecision,
  resolveQuotaResumeRetryDelayMs,
  resolveQuotaResumeSettings,
  resolveQuotaSuspensionTtlMsFromCooldownExpiry,
} from "./quota-resume-policy.js";

const SUSPENDED_AT = 1_000_000;

function suspension(overrides: Partial<QuotaSuspension> = {}): QuotaSuspension {
  return {
    schemaVersion: 1,
    suspendedAt: SUSPENDED_AT,
    reason: "quota_exhausted",
    failedProvider: "openai-codex",
    failedModel: "gpt-6-astra",
    expectedResumeBy: SUSPENDED_AT + 60_000,
    state: "suspended",
    ...overrides,
  };
}

function decide(params: {
  quotaSuspension?: QuotaSuspension;
  now?: number;
  runActive?: boolean;
  providerCooldownUntilMs?: number | null;
  abortedLastRun?: boolean;
  lastInteractionAt?: number;
  maxAttempts?: number;
}) {
  return resolveQuotaResumeDecision({
    maxAttempts: params.maxAttempts,
    entry: {
      sessionId: "session-1",
      quotaSuspension: params.quotaSuspension,
      abortedLastRun: params.abortedLastRun,
      lastInteractionAt: params.lastInteractionAt,
    },
    now: params.now ?? SUSPENDED_AT + 120_000,
    runActive: params.runActive ?? false,
    providerCooldownUntilMs: params.providerCooldownUntilMs,
  });
}

describe("quota resume policy", () => {
  it("launches a quota suspension once its resume time has passed", () => {
    expect(decide({ quotaSuspension: suspension() })).toEqual({ action: "launch", attempt: 1 });
  });

  it("waits until the stored resume time", () => {
    expect(decide({ quotaSuspension: suspension(), now: SUSPENDED_AT + 10_000 })).toEqual({
      action: "wait",
      resumeAtMs: SUSPENDED_AT + 60_000,
    });
  });

  it("honors a later provider cooldown with a margin", () => {
    const cooldownUntil = SUSPENDED_AT + 300_000;
    expect(
      decide({
        quotaSuspension: suspension(),
        now: SUSPENDED_AT + 120_000,
        providerCooldownUntilMs: cooldownUntil,
      }),
    ).toEqual({ action: "wait", resumeAtMs: cooldownUntil + QUOTA_RESUME_COOLDOWN_MARGIN_MS });
  });

  it("ignores expired or implausibly distant provider cooldowns", () => {
    const now = SUSPENDED_AT + 120_000;
    expect(
      decide({ quotaSuspension: suspension(), now, providerCooldownUntilMs: now - 1 }),
    ).toEqual({ action: "launch", attempt: 1 });
    expect(
      decide({
        quotaSuspension: suspension(),
        now,
        providerCooldownUntilMs: now + QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS + 1,
      }),
    ).toEqual({ action: "launch", attempt: 1 });
  });

  it("skips sessions without a time-based quota suspension", () => {
    expect(decide({})).toEqual({ action: "skip", reason: "not_suspended" });
    expect(decide({ quotaSuspension: suspension({ state: "active" }) })).toEqual({
      action: "skip",
      reason: "not_suspended",
    });
    expect(decide({ quotaSuspension: suspension({ reason: "manual" }) })).toEqual({
      action: "skip",
      reason: "not_quota",
    });
    expect(decide({ quotaSuspension: suspension({ reason: "circuit_open" }) })).toEqual({
      action: "skip",
      reason: "not_quota",
    });
  });

  it("never restarts a session the operator stopped or already continued", () => {
    expect(decide({ quotaSuspension: suspension(), abortedLastRun: true })).toEqual({
      action: "skip",
      reason: "aborted",
    });
    expect(decide({ quotaSuspension: suspension(), lastInteractionAt: SUSPENDED_AT + 1 })).toEqual({
      action: "skip",
      reason: "superseded",
    });
    expect(decide({ quotaSuspension: suspension(), lastInteractionAt: SUSPENDED_AT - 1 })).toEqual({
      action: "launch",
      attempt: 1,
    });
  });

  it("defers while a run is active and stops after the attempt budget", () => {
    expect(decide({ quotaSuspension: suspension(), runActive: true })).toEqual({
      action: "skip",
      reason: "run_active",
    });
    expect(
      decide({
        quotaSuspension: suspension({
          autoResume: { attempts: QUOTA_RESUME_MAX_ATTEMPTS, nextAttemptAt: SUSPENDED_AT },
        }),
      }),
    ).toEqual({ action: "skip", reason: "attempts_exhausted" });
    expect(
      decide({
        quotaSuspension: suspension({ autoResume: { attempts: 2, nextAttemptAt: SUSPENDED_AT } }),
        maxAttempts: 2,
      }),
    ).toEqual({ action: "skip", reason: "attempts_exhausted" });
  });

  it("applies agents.defaults.quotaResume defaults and bounds", () => {
    expect(resolveQuotaResumeSettings(undefined)).toEqual({
      enabled: true,
      maxAttempts: QUOTA_RESUME_MAX_ATTEMPTS,
    });
    expect(
      resolveQuotaResumeSettings({
        agents: { defaults: { quotaResume: { enabled: false, maxAttempts: 3 } } },
      }),
    ).toEqual({ enabled: false, maxAttempts: 3 });
    expect(
      resolveQuotaResumeSettings({ agents: { defaults: { quotaResume: { maxAttempts: 0 } } } })
        .maxAttempts,
    ).toBe(QUOTA_RESUME_MAX_ATTEMPTS);
  });

  it("treats a fresh launch as in flight and an old one as lost", () => {
    const launchedAt = SUSPENDED_AT + 60_000;
    const resuming = suspension({
      state: "resuming",
      autoResume: { attempts: 1, lastAttemptAt: launchedAt, nextAttemptAt: launchedAt },
    });
    expect(decide({ quotaSuspension: resuming, now: launchedAt + 1_000 })).toEqual({
      action: "skip",
      reason: "launch_in_flight",
    });
    expect(
      decide({ quotaSuspension: resuming, now: launchedAt + QUOTA_RESUME_LAUNCH_GRACE_MS }),
    ).toEqual({ action: "launch", attempt: 2 });
  });

  it("launches a resuming marker left by lazy maintenance", () => {
    expect(decide({ quotaSuspension: suspension({ state: "resuming" }) })).toEqual({
      action: "launch",
      attempt: 1,
    });
  });

  it("uses the recorded next attempt time over the original TTL", () => {
    const nextAttemptAt = SUSPENDED_AT + 900_000;
    expect(
      resolveQuotaResumeAtMs({
        suspension: suspension({ autoResume: { attempts: 1, nextAttemptAt } }),
        now: SUSPENDED_AT + 120_000,
      }),
    ).toBe(nextAttemptAt);
  });

  it("backs off exponentially up to the cap when no reset time is known", () => {
    expect(resolveQuotaResumeRetryDelayMs(0)).toBe(QUOTA_RESUME_DEFAULT_RETRY_MS);
    expect(resolveQuotaResumeRetryDelayMs(1)).toBe(QUOTA_RESUME_DEFAULT_RETRY_MS * 2);
    expect(resolveQuotaResumeRetryDelayMs(20)).toBe(QUOTA_RESUME_MAX_RETRY_MS);
    expect(
      resolveQuotaResumeAtMs({
        suspension: suspension({ expectedResumeBy: undefined }),
        now: SUSPENDED_AT,
      }),
    ).toBe(SUSPENDED_AT + QUOTA_RESUME_DEFAULT_RETRY_MS);
  });

  it("derives a suspension TTL from a plausible cooldown expiry only", () => {
    const now = 5_000_000;
    expect(resolveQuotaSuspensionTtlMsFromCooldownExpiry(now + 60_000, now)).toBe(
      60_000 + QUOTA_RESUME_COOLDOWN_MARGIN_MS,
    );
    expect(resolveQuotaSuspensionTtlMsFromCooldownExpiry(now - 60_000, now)).toBeUndefined();
    expect(resolveQuotaSuspensionTtlMsFromCooldownExpiry(null, now)).toBeUndefined();
    expect(resolveQuotaSuspensionTtlMsFromCooldownExpiry(Number.NaN, now)).toBeUndefined();
    expect(
      resolveQuotaSuspensionTtlMsFromCooldownExpiry(
        now + QUOTA_RESUME_MAX_COOLDOWN_HORIZON_MS + 60_000,
        now,
      ),
    ).toBeUndefined();
  });
});
