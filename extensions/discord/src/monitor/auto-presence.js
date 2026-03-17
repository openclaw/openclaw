import {
  clearExpiredCooldowns,
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveProfilesUnavailableReason
} from "../../../../src/agents/auth-profiles.js";
import { warn } from "../../../../src/globals.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";
const DEFAULT_CUSTOM_ACTIVITY_TYPE = 4;
const CUSTOM_STATUS_NAME = "Custom Status";
const DEFAULT_INTERVAL_MS = 3e4;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15e3;
const MIN_INTERVAL_MS = 5e3;
const MIN_UPDATE_INTERVAL_MS = 1e3;
function normalizeOptionalText(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function clampPositiveInt(value, fallback, minValue) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.max(minValue, rounded);
}
function resolveAutoPresenceConfig(config) {
  const intervalMs = clampPositiveInt(config?.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  const minUpdateIntervalMs = clampPositiveInt(
    config?.minUpdateIntervalMs,
    DEFAULT_MIN_UPDATE_INTERVAL_MS,
    MIN_UPDATE_INTERVAL_MS
  );
  return {
    enabled: config?.enabled === true,
    intervalMs,
    minUpdateIntervalMs,
    healthyText: normalizeOptionalText(config?.healthyText),
    degradedText: normalizeOptionalText(config?.degradedText),
    exhaustedText: normalizeOptionalText(config?.exhaustedText)
  };
}
function buildCustomStatusActivity(text) {
  return {
    name: CUSTOM_STATUS_NAME,
    type: DEFAULT_CUSTOM_ACTIVITY_TYPE,
    state: text
  };
}
function renderTemplate(template, vars) {
  const rendered = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key) => vars[key] ?? "").replace(/\s+/g, " ").trim();
  return rendered.length > 0 ? rendered : void 0;
}
function isExhaustedUnavailableReason(reason) {
  if (!reason) {
    return false;
  }
  return reason === "rate_limit" || reason === "overloaded" || reason === "billing" || reason === "auth" || reason === "auth_permanent";
}
function formatUnavailableReason(reason) {
  if (!reason) {
    return "unknown";
  }
  return reason.replace(/_/g, " ");
}
function resolveAuthAvailability(params) {
  const profileIds = Object.keys(params.store.profiles);
  if (profileIds.length === 0) {
    return { state: "degraded", unavailableReason: null };
  }
  clearExpiredCooldowns(params.store, params.now);
  const hasUsableProfile = profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, params.now)
  );
  if (hasUsableProfile) {
    return { state: "healthy", unavailableReason: null };
  }
  const unavailableReason = resolveProfilesUnavailableReason({
    store: params.store,
    profileIds,
    now: params.now
  });
  if (isExhaustedUnavailableReason(unavailableReason)) {
    return {
      state: "exhausted",
      unavailableReason
    };
  }
  return {
    state: "degraded",
    unavailableReason
  };
}
function resolvePresenceActivities(params) {
  const reasonLabel = formatUnavailableReason(params.unavailableReason ?? null);
  if (params.state === "healthy") {
    if (params.cfg.healthyText) {
      return [buildCustomStatusActivity(params.cfg.healthyText)];
    }
    return params.basePresence?.activities ?? [];
  }
  if (params.state === "degraded") {
    const template2 = params.cfg.degradedText ?? "runtime degraded";
    const text2 = renderTemplate(template2, { reason: reasonLabel });
    return text2 ? [buildCustomStatusActivity(text2)] : [];
  }
  const defaultTemplate = isExhaustedUnavailableReason(params.unavailableReason ?? null) ? "token exhausted" : "model unavailable ({reason})";
  const template = params.cfg.exhaustedText ?? defaultTemplate;
  const text = renderTemplate(template, { reason: reasonLabel });
  return text ? [buildCustomStatusActivity(text)] : [];
}
function resolvePresenceStatus(state) {
  if (state === "healthy") {
    return "online";
  }
  if (state === "exhausted") {
    return "dnd";
  }
  return "idle";
}
function resolveDiscordAutoPresenceDecision(params) {
  const autoPresence = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
  if (!autoPresence.enabled) {
    return null;
  }
  const now = params.now ?? Date.now();
  const basePresence = resolveDiscordPresenceUpdate(params.discordConfig);
  const availability = resolveAuthAvailability({
    store: params.authStore,
    now
  });
  const state = params.gatewayConnected ? availability.state : "degraded";
  const unavailableReason = params.gatewayConnected ? availability.unavailableReason : availability.unavailableReason ?? "unknown";
  const activities = resolvePresenceActivities({
    state,
    cfg: autoPresence,
    basePresence,
    unavailableReason
  });
  return {
    state,
    unavailableReason,
    presence: {
      since: null,
      activities,
      status: resolvePresenceStatus(state),
      afk: false
    }
  };
}
function stablePresenceSignature(payload) {
  return JSON.stringify({
    status: payload.status,
    afk: payload.afk,
    since: payload.since,
    activities: payload.activities.map((activity) => ({
      type: activity.type,
      name: activity.name,
      state: activity.state,
      url: activity.url
    }))
  });
}
function createDiscordAutoPresenceController(params) {
  const autoCfg = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
  if (!autoCfg.enabled) {
    return {
      enabled: false,
      start: () => void 0,
      stop: () => void 0,
      refresh: () => void 0,
      runNow: () => void 0
    };
  }
  const loadAuthStore = params.loadAuthStore ?? (() => ensureAuthProfileStore());
  const now = params.now ?? (() => Date.now());
  const setIntervalFn = params.setIntervalFn ?? setInterval;
  const clearIntervalFn = params.clearIntervalFn ?? clearInterval;
  let timer;
  let lastAppliedSignature = null;
  let lastAppliedAt = 0;
  const runEvaluation = (options) => {
    let decision = null;
    try {
      decision = resolveDiscordAutoPresenceDecision({
        discordConfig: params.discordConfig,
        authStore: loadAuthStore(),
        gatewayConnected: params.gateway.isConnected,
        now: now()
      });
    } catch (err) {
      params.log?.(
        warn(
          `discord: auto-presence evaluation failed for account ${params.accountId}: ${String(err)}`
        )
      );
      return;
    }
    if (!decision || !params.gateway.isConnected) {
      return;
    }
    const forceApply = options?.force === true;
    const ts = now();
    const signature = stablePresenceSignature(decision.presence);
    if (!forceApply && signature === lastAppliedSignature) {
      return;
    }
    if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) {
      return;
    }
    params.gateway.updatePresence(decision.presence);
    lastAppliedSignature = signature;
    lastAppliedAt = ts;
  };
  return {
    enabled: true,
    runNow: () => runEvaluation(),
    refresh: () => runEvaluation({ force: true }),
    start: () => {
      if (timer) {
        return;
      }
      runEvaluation({ force: true });
      timer = setIntervalFn(() => runEvaluation(), autoCfg.intervalMs);
    },
    stop: () => {
      if (!timer) {
        return;
      }
      clearIntervalFn(timer);
      timer = void 0;
    }
  };
}
const __testing = {
  resolveAutoPresenceConfig,
  resolveAuthAvailability,
  stablePresenceSignature
};
export {
  __testing,
  createDiscordAutoPresenceController,
  resolveDiscordAutoPresenceDecision
};
