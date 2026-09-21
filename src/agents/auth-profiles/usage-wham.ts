/**
 * ChatGPT/Codex usage endpoint ("WHAM") payload schema and the pure
 * classification of a parsed payload into an auth-profile probe result.
 * The request, HTTP-status handling, and store mutation stay in usage.ts.
 */
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import type { AuthProfileCooldownClassification } from "./types.js";
import { resolveUsageWindowUntil } from "./usage-failure-state.js";

const WHAM_BURST_COOLDOWN_MS = 15_000;
export const WHAM_PROBE_FAILURE_COOLDOWN_MS = 30_000;

const whamUsageWindowSchema = z.object({
  used_percent: z.number().optional(),
  reset_at: z.number().optional(),
  reset_after_seconds: z.number().optional(),
});
type WhamUsageWindow = z.infer<typeof whamUsageWindowSchema>;
const whamRateLimitSchema = z.object({
  limit_reached: z.boolean().optional(),
  primary_window: whamUsageWindowSchema.nullish(),
  secondary_window: whamUsageWindowSchema.nullish(),
});
const whamCreditsSchema = z.object({
  has_credits: z.boolean().optional(),
  unlimited: z.boolean().optional(),
  overage_limit_reached: z.boolean().optional(),
});
export const whamUsageSchema = z.object({
  rate_limit: whamRateLimitSchema,
  additional_rate_limits: z
    .array(z.object({ rate_limit: whamRateLimitSchema.nullish() }))
    .nullish(),
  spend_control: z.object({ reached: z.boolean() }).nullish(),
  credits: whamCreditsSchema.nullish(),
  rate_limit_reached_type: z
    .object({
      type: z.enum([
        "rate_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_member_credits_depleted",
        "workspace_owner_usage_limit_reached",
        "workspace_member_usage_limit_reached",
        "unknown",
      ]),
    })
    .nullish(),
});
export type WhamUsage = z.infer<typeof whamUsageSchema>;

export type WhamCooldownProbeResult = {
  available?: true;
  cooldownMs: number;
  cooldownClassification?: AuthProfileCooldownClassification;
  blockedUntil?: number;
};

function resolveWhamResetMs(window: WhamUsageWindow, now: number): number | null {
  if (window.reset_after_seconds !== undefined && window.reset_after_seconds > 0) {
    return positiveSecondsToSafeMilliseconds(window.reset_after_seconds) ?? null;
  }
  if (window.reset_at !== undefined && window.reset_at > 0) {
    const resetAtMs = resolveExpiresAtMsFromEpochSeconds(window.reset_at);
    return resetAtMs === undefined ? null : Math.max(0, resetAtMs - now);
  }
  return null;
}

function isWhamWindowExhausted(
  window: WhamUsageWindow | null | undefined,
): window is WhamUsageWindow {
  return window?.used_percent !== undefined && window.used_percent >= 100;
}

/**
 * Purchased credits keep serving requests after the included usage windows are
 * exhausted, so an exhausted personal window alone is not a reason to block the
 * profile until the window resets. Only the plain `rate_limit_reached` state
 * (or an older payload without a reached type) is covered: depleted workspace
 * credits, admin-set workspace usage caps, and a reached overage cap still mean
 * "no capacity" even when the account reports a credit balance.
 */
function whamCreditsCoverExhaustedWindows(usage: WhamUsage): boolean {
  const credits = usage.credits;
  if (!credits || credits.overage_limit_reached === true) {
    return false;
  }
  if (credits.unlimited !== true && credits.has_credits !== true) {
    return false;
  }
  const reachedType = usage.rate_limit_reached_type?.type;
  return reachedType === undefined || reachedType === "rate_limit_reached";
}

/** Maps a parsed usage payload to the probe result recorded on the profile. */
export function classifyWhamUsage(usage: WhamUsage, now: number): WhamCooldownProbeResult {
  const failedProbe = { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS };
  if (usage.spend_control?.reached) {
    return failedProbe;
  }
  const limits = [
    usage.rate_limit,
    ...(usage.additional_rate_limits ?? []).flatMap((entry) =>
      entry.rate_limit ? [entry.rate_limit] : [],
    ),
  ];
  let resetMs = 0;
  for (const limit of limits) {
    const windows = [limit.primary_window, limit.secondary_window].filter(isWhamWindowExhausted);
    if (limit.limit_reached === false && windows.length === 0) {
      continue;
    }
    // Older personal usage responses identify the reached limit without a percentage.
    if (windows.length === 0 && limit.primary_window && !limit.secondary_window) {
      windows.push(limit.primary_window);
    }
    if (windows.length === 0) {
      return failedProbe;
    }
    for (const window of windows) {
      const remainingMs = resolveWhamResetMs(window, now);
      if (remainingMs === null || remainingMs <= 0) {
        return failedProbe;
      }
      resetMs = Math.max(resetMs, remainingMs);
    }
  }
  const reachedType = usage.rate_limit_reached_type?.type;
  if (resetMs === 0 && reachedType && reachedType !== "unknown") {
    return failedProbe;
  }
  if (resetMs > 0 && whamCreditsCoverExhaustedWindows(usage)) {
    return { available: true, cooldownMs: WHAM_BURST_COOLDOWN_MS };
  }
  return resetMs > 0
    ? {
        cooldownMs: WHAM_BURST_COOLDOWN_MS,
        blockedUntil: resolveUsageWindowUntil(now, resetMs),
      }
    : { available: true, cooldownMs: WHAM_BURST_COOLDOWN_MS };
}
