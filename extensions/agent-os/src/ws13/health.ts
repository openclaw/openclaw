// Agent OS WS13 — L1 proof: static/simulated self-check + health derivation.
//
// This is NOT a Gateway startup self-check. It is a pure deterministic
// classifier over a declared input model (which hooks are registered, whether
// the plugin is active, whether the store is available). It proves health
// transitions only; it never activates a runtime, never restarts Gateway, and
// never claims production fail-closed behavior.

import {
  WS13_REQUIRED_HOOKS,
  type Ws13AlertCapability,
  type Ws13HealthState,
  type Ws13RequiredHookName,
  type Ws13SelfCheckInput,
  type Ws13SelfCheckResult,
} from "./types.js";

export function runSelfCheck(
  input: Ws13SelfCheckInput,
): Ws13SelfCheckResult {
  const available = new Set(input.availableHooks);
  const missingHooks: Ws13RequiredHookName[] = WS13_REQUIRED_HOOKS.filter(
    (hook) => !available.has(hook),
  );

  let health: Ws13HealthState;
  if (!input.pluginActive) {
    health = "unhealthy_plugin_inactive";
  } else if (missingHooks.length > 0) {
    health = "unhealthy_required_hook_missing";
  } else if (!input.storeAvailable) {
    health = "unhealthy_store_unavailable";
  } else {
    health = "healthy_simulated";
  }

  const enforcementActive = health === "healthy_simulated";

  return {
    health,
    missingHooks,
    active: input.pluginActive,
    enforcementActive,
  };
}

// Static alert-capability classification (handoff §11). No live alert is ever
// sent in L1. Source proof Q4: the only source-proven active remediation route
// is inside an *active* reply_dispatch turn; there is no source-proven general
// out-of-band send/alert API from subagent_ended or message_sent. The exact
// WS13 failure (no reply dispatch queued at all) therefore has no proven
// out-of-band route — classify conservatively as not source-proven.
export function classifyAlertCapability(opts: {
  replyDispatchAvailable: boolean;
  approvedPluginSendApiAvailable: boolean;
  hasActiveDispatchContext: boolean;
}): Ws13AlertCapability {
  if (opts.approvedPluginSendApiAvailable) {
    return "alert_capable_via_approved_plugin_api";
  }
  if (opts.replyDispatchAvailable && opts.hasActiveDispatchContext) {
    return "alert_capable_via_reply_dispatch";
  }
  return "alert_not_source_proven";
}

// Convenience: does this health state permit reporting enforcement as active?
export function enforcementMayBeActive(health: Ws13HealthState): boolean {
  return health === "healthy_simulated";
}
