import {
  clearExpiredCooldowns,
  ensureAuthProfileStoreAsync,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  type AuthProfileFailureReason,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import type {
  DiscordAccountConfig,
  DiscordAutoPresenceConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { warn } from "openclaw/plugin-sdk/runtime-env";
import type { UpdatePresenceData } from "../internal/plugin-contract.js";
import { resolveDiscordPresenceUpdate } from "./presence.js";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_MIN_UPDATE_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;
const MIN_UPDATE_INTERVAL_MS = 1_000;

type DiscordAutoPresenceState = "healthy" | "degraded" | "exhausted";
type DiscordPresenceConfig = Pick<
  DiscordAccountConfig,
  "autoPresence" | "activity" | "status" | "activityType" | "activityUrl"
>;
const EXHAUSTED_REASONS = new Set<AuthProfileFailureReason>([
  "rate_limit",
  "overloaded",
  "billing",
  "auth",
  "auth_permanent",
]);

type PresenceGateway = {
  isConnected: boolean;
  updatePresence: (payload: UpdatePresenceData) => void;
};

function clampPositiveInt(value: unknown, fallback: number, minValue: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.round(value);
  if (rounded <= 0) {
    return fallback;
  }
  return Math.max(minValue, rounded);
}

function resolveAutoPresenceConfig(config?: DiscordAutoPresenceConfig) {
  const intervalMs = clampPositiveInt(config?.intervalMs, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS);
  const minUpdateIntervalMs = clampPositiveInt(
    config?.minUpdateIntervalMs,
    DEFAULT_MIN_UPDATE_INTERVAL_MS,
    MIN_UPDATE_INTERVAL_MS,
  );

  return {
    enabled: config?.enabled === true,
    intervalMs,
    minUpdateIntervalMs,
  };
}

function resolveAuthAvailability(params: {
  store: AuthProfileStore;
  now: number;
}): DiscordAutoPresenceState {
  const profileIds = Object.keys(params.store.profiles);
  if (profileIds.length === 0) {
    return "degraded";
  }

  clearExpiredCooldowns(params.store, params.now);

  const hasUsableProfile = profileIds.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, params.now),
  );
  if (hasUsableProfile) {
    return "healthy";
  }

  const unavailableReason = resolveProfilesUnavailableReason({
    store: params.store,
    profileIds,
    now: params.now,
  });

  return unavailableReason !== null && EXHAUSTED_REASONS.has(unavailableReason)
    ? "exhausted"
    : "degraded";
}

function resolveDiscordAutoPresenceUpdate(params: {
  discordConfig: DiscordPresenceConfig;
  authStore: AuthProfileStore;
  gatewayConnected: boolean;
  now: number;
}): UpdatePresenceData {
  const basePresence = resolveDiscordPresenceUpdate(params.discordConfig);

  const availability = resolveAuthAvailability({
    store: params.authStore,
    now: params.now,
  });
  const state = params.gatewayConnected ? availability : "degraded";

  return state === "healthy"
    ? { since: null, activities: basePresence.activities, status: "online", afk: false }
    : resolveDiscordPresenceUpdate({
        activity: state === "degraded" ? "runtime degraded" : "token exhausted",
        status: state === "degraded" ? "idle" : "dnd",
      });
}

function stablePresenceSignature(payload: UpdatePresenceData): string {
  return JSON.stringify({
    status: payload.status,
    afk: payload.afk,
    since: payload.since,
    activities: payload.activities.map((activity) => ({
      type: activity.type,
      name: activity.name,
      state: activity.state,
      url: activity.url,
    })),
  });
}

type DiscordAutoPresenceController = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  enabled: boolean;
};

export function createDiscordAutoPresenceController(params: {
  scheduler: PluginServiceSchedulerV1;
  accountId: string;
  discordConfig: DiscordPresenceConfig;
  gateway: PresenceGateway;
  loadAuthStore?: () => AuthProfileStore | Promise<AuthProfileStore>;
  log?: (message: string) => void;
}): DiscordAutoPresenceController {
  const autoCfg = resolveAutoPresenceConfig(params.discordConfig.autoPresence);
  const loadAuthStore = params.loadAuthStore ?? (() => ensureAuthProfileStoreAsync());
  const now = params.scheduler.now;

  const scheduler = params.scheduler.scope();
  let started = false;
  let lastAppliedSignature: string | null = null;
  let lastAppliedAt = 0;

  const runEvaluation = async (options?: { force?: boolean }) => {
    if (!autoCfg.enabled || scheduler.signal.aborted) {
      return;
    }
    let presence: UpdatePresenceData;
    try {
      presence = resolveDiscordAutoPresenceUpdate({
        discordConfig: params.discordConfig,
        authStore: await loadAuthStore(),
        gatewayConnected: params.gateway.isConnected,
        now: now(),
      });
    } catch (err) {
      params.log?.(
        warn(
          `discord: auto-presence evaluation failed for account ${params.accountId}: ${String(err)}`,
        ),
      );
      return;
    }

    if (scheduler.signal.aborted || !params.gateway.isConnected) {
      return;
    }

    const forceApply = options?.force === true;
    const ts = now();
    const signature = stablePresenceSignature(presence);
    if (!forceApply && signature === lastAppliedSignature) {
      return;
    }
    if (!forceApply && lastAppliedAt > 0 && ts - lastAppliedAt < autoCfg.minUpdateIntervalMs) {
      return;
    }

    params.gateway.updatePresence(presence);
    lastAppliedSignature = signature;
    lastAppliedAt = ts;
  };

  return {
    enabled: autoCfg.enabled,
    refresh: () => runEvaluation({ force: true }),
    start: async () => {
      if (!autoCfg.enabled || started || scheduler.signal.aborted) {
        return;
      }
      started = true;
      const initialEvaluation = runEvaluation({ force: true });
      scheduler.schedule({
        id: "presence",
        delayMs: autoCfg.intervalMs,
        everyMs: autoCfg.intervalMs,
        run: () => runEvaluation(),
      });
      await initialEvaluation;
    },
    stop: () => scheduler.stop(),
  };
}
