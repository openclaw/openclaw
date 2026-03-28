import { parseDurationMs } from "../../cli/parse-duration.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveProviderCacheTtlEligibility } from "../../plugins/provider-runtime.js";
import { resolveCacheRetention } from "./anthropic-stream-wrappers.js";
import { resolveExtraParams } from "./extra-params.js";
import { log } from "./logger.js";

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";

export type CacheTtlEntryData = {
  timestamp: number;
  provider?: string;
  modelId?: string;
};

const CACHE_RETENTION_TTL_MS = {
  short: 5 * 60_000,
  long: 60 * 60_000,
} as const;
const MAX_WARNED_SESSION_CACHE_TTL_MISMATCH_KEYS = 1_000;
const warnedSessionCacheTtlMismatchKeys = new Set<string>();

export type TimeBasedContextCompactMode = "none" | "compact" | "reset";

export function isCacheTtlEligibleProvider(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();
  const pluginEligibility = resolveProviderCacheTtlEligibility({
    provider: normalizedProvider,
    context: {
      provider: normalizedProvider,
      modelId: normalizedModelId,
    },
  });
  if (pluginEligibility !== undefined) {
    return pluginEligibility;
  }
  return false;
}

export function readLastCacheTtlTimestamp(sessionManager: unknown): number | null {
  const sm = sessionManager as { getEntries?: () => CustomEntryLike[] };
  if (!sm?.getEntries) {
    return null;
  }
  try {
    const entries = sm.getEntries();
    let last: number | null = null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as Partial<CacheTtlEntryData> | undefined;
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (ts && Number.isFinite(ts)) {
        last = ts;
        break;
      }
    }
    return last;
  } catch {
    return null;
  }
}

export function appendCacheTtlTimestamp(sessionManager: unknown, data: CacheTtlEntryData): void {
  const sm = sessionManager as {
    appendCustomEntry?: (customType: string, data: unknown) => void;
  };
  if (!sm?.appendCustomEntry) {
    return;
  }
  try {
    sm.appendCustomEntry(CACHE_TTL_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}

export function resolveCacheRetentionTtlMs(
  cacheRetention: "none" | "short" | "long" | undefined,
): number | null {
  if (!cacheRetention || cacheRetention === "none") {
    return null;
  }
  return CACHE_RETENTION_TTL_MS[cacheRetention];
}

function parsePositiveDuration(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    const ttlMs = parseDurationMs(value.trim(), { defaultUnit: "m" });
    return ttlMs > 0 ? ttlMs : null;
  } catch {
    return null;
  }
}

function resolveConfiguredSessionCacheTtlMs(
  extraParams: Record<string, unknown> | undefined,
): number | null {
  return parsePositiveDuration(extraParams?.sessionCacheTtl);
}

export function resolveTimeBasedContextCompactMode(
  extraParams: Record<string, unknown> | undefined,
): TimeBasedContextCompactMode {
  const mode = extraParams?.timeBasedContextCompact;
  return mode === "compact" || mode === "reset" ? mode : "none";
}

function resolveExplicitModelCacheTtlMs(
  extraParams: Record<string, unknown> | undefined,
  provider: string,
): number | null {
  if (!extraParams) {
    return null;
  }
  if (Object.hasOwn(extraParams, "cacheRetention")) {
    const cacheRetention = resolveCacheRetention(extraParams, provider);
    if (cacheRetention === "none") {
      return null;
    }
    return resolveCacheRetentionTtlMs(cacheRetention);
  }
  if (Object.hasOwn(extraParams, "cacheControlTtl")) {
    return parsePositiveDuration(extraParams.cacheControlTtl);
  }
  return null;
}

function maybeWarnSessionCacheTtlMismatch(params: {
  provider: string;
  modelId: string;
  sessionCacheTtlMs: number;
  explicitModelCacheTtlMs: number;
}) {
  const warningKey = [
    params.provider,
    params.modelId,
    params.sessionCacheTtlMs,
    params.explicitModelCacheTtlMs,
  ].join(":");
  if (warnedSessionCacheTtlMismatchKeys.has(warningKey)) {
    return;
  }
  if (warnedSessionCacheTtlMismatchKeys.size >= MAX_WARNED_SESSION_CACHE_TTL_MISMATCH_KEYS) {
    warnedSessionCacheTtlMismatchKeys.clear();
  }
  warnedSessionCacheTtlMismatchKeys.add(warningKey);
  log.warn("sessionCacheTtl exceeds explicit model cache ttl", {
    provider: params.provider,
    modelId: params.modelId,
    sessionCacheTtlMs: params.sessionCacheTtlMs,
    explicitModelCacheTtlMs: params.explicitModelCacheTtlMs,
  });
}

export function resolveCacheTtlMs(params: {
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
}): number | null {
  if (!isCacheTtlEligibleProvider(params.provider, params.modelId)) {
    return null;
  }

  const resolvedExtraParams = resolveExtraParams({
    cfg: params.config,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  });
  const timeBasedContextCompact = resolveTimeBasedContextCompactMode(resolvedExtraParams);
  if (timeBasedContextCompact === "none") {
    return null;
  }
  const sessionCacheTtlMs = resolveConfiguredSessionCacheTtlMs(resolvedExtraParams);
  if (sessionCacheTtlMs == null) {
    return null;
  }

  const explicitModelCacheTtlMs = resolveExplicitModelCacheTtlMs(
    resolvedExtraParams,
    params.provider,
  );
  if (explicitModelCacheTtlMs != null && sessionCacheTtlMs > explicitModelCacheTtlMs) {
    maybeWarnSessionCacheTtlMismatch({
      provider: params.provider,
      modelId: params.modelId,
      sessionCacheTtlMs,
      explicitModelCacheTtlMs,
    });
  }
  return sessionCacheTtlMs;
}
