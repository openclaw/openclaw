import { stateLog } from "./constants.js";
import type { AuthProfileFailureReason, ProfileUsageStats } from "./types.js";

export function logAuthProfileFailureStateChange(params: {
  profileId: string;
  provider: string;
  reason: AuthProfileFailureReason;
  previous: ProfileUsageStats | undefined;
  next: ProfileUsageStats;
  now: number;
}): void {
  const windowType =
    params.reason === "billing" || params.reason === "auth_permanent" ? "disabled" : "cooldown";
  const previousCooldownUntil = params.previous?.cooldownUntil;
  const previousDisabledUntil = params.previous?.disabledUntil;
  // Active cooldown/disable windows are intentionally immutable; log whether this
  // update reused the existing window instead of extending it.
  const windowReused =
    windowType === "disabled"
      ? typeof previousDisabledUntil === "number" &&
        Number.isFinite(previousDisabledUntil) &&
        previousDisabledUntil > params.now &&
        previousDisabledUntil === params.next.disabledUntil
      : typeof previousCooldownUntil === "number" &&
        Number.isFinite(previousCooldownUntil) &&
        previousCooldownUntil > params.now &&
        previousCooldownUntil === params.next.cooldownUntil;

  stateLog.warn("auth profile failure state updated", {
    event: "auth_profile_failure_state_updated",
    tags: ["error_handling", "auth_profiles", windowType],
    profileId: params.profileId,
    provider: params.provider,
    reason: params.reason,
    windowType,
    windowReused,
    previousErrorCount: params.previous?.errorCount,
    errorCount: params.next.errorCount,
    previousCooldownUntil,
    cooldownUntil: params.next.cooldownUntil,
    previousDisabledUntil,
    disabledUntil: params.next.disabledUntil,
    previousDisabledReason: params.previous?.disabledReason,
    disabledReason: params.next.disabledReason,
    failureCounts: params.next.failureCounts,
    consoleMessage:
      `auth profile failure state updated: profile=${params.profileId} provider=${params.provider} ` +
      `reason=${params.reason} window=${windowType} reused=${String(windowReused)}`,
  });
}
