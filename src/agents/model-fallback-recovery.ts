import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import { modelKey, normalizeModelRef } from "./model-selection-normalize.js";
import { buildModelAliasIndex, resolveModelRefFromString } from "./model-selection-resolve.js";

const RECOVERY_SCOPE_DELIMITER = "::";
const PRIMARY_RECOVERY_PROBE_INTERVAL_MS = 60_000;
const PRIMARY_RECOVERY_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PRIMARY_RECOVERY_KEYS = 256;

type PrimaryRecoveryState = {
  primary: ModelCandidate;
  fallback: ModelCandidate;
  failedAt: number;
  lastProbeAt: number;
  reason?: string;
};

const primaryRecoveryState = new Map<string, PrimaryRecoveryState>();

function sameCandidate(a: ModelCandidate | undefined, b: ModelCandidate | undefined): boolean {
  return Boolean(a && b && a.provider === b.provider && a.model === b.model);
}

function resolvePrimaryRecoveryKey(primary: ModelCandidate, agentDir?: string): string {
  const scope = normalizeOptionalString(agentDir) ?? "";
  const key = modelKey(primary.provider, primary.model);
  return scope ? `${scope}${RECOVERY_SCOPE_DELIMITER}${key}` : key;
}

function prunePrimaryRecoveryState(now: number): void {
  for (const [key, state] of primaryRecoveryState) {
    if (!Number.isFinite(state.failedAt) || now - state.failedAt > PRIMARY_RECOVERY_STATE_TTL_MS) {
      primaryRecoveryState.delete(key);
    }
  }
}

function enforcePrimaryRecoveryStateCap(): void {
  while (primaryRecoveryState.size > MAX_PRIMARY_RECOVERY_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, state] of primaryRecoveryState) {
      if (state.failedAt < oldestTs) {
        oldestKey = key;
        oldestTs = state.failedAt;
      }
    }
    if (!oldestKey) {
      break;
    }
    primaryRecoveryState.delete(oldestKey);
  }
}

function normalizeCandidate(provider: string, model: string): ModelCandidate {
  return normalizeModelRef(provider, model);
}

export function resolvePrimaryRecoveryFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  fallbackRefs?: string[];
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider || DEFAULT_PROVIDER,
  });
  const fallbackRefs =
    params.fallbackRefs ?? resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  const candidates: ModelCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of fallbackRefs) {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: params.defaultProvider || DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    const key = modelKey(resolved.ref.provider, resolved.ref.model);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    candidates.push(resolved.ref);
  }
  return candidates;
}

export function recordPrimaryRecoverySuccess(params: {
  primary: ModelCandidate;
  agentDir?: string;
}): void {
  primaryRecoveryState.delete(resolvePrimaryRecoveryKey(params.primary, params.agentDir));
}

export function recordPrimaryRecoveryFallback(params: {
  primary: ModelCandidate;
  fallback: ModelCandidate;
  attempts?: FallbackAttempt[];
  agentDir?: string;
  now?: number;
}): void {
  if (sameCandidate(params.primary, params.fallback)) {
    return;
  }
  const now = params.now ?? Date.now();
  prunePrimaryRecoveryState(now);
  const key = resolvePrimaryRecoveryKey(params.primary, params.agentDir);
  const previous = primaryRecoveryState.get(key);
  primaryRecoveryState.set(key, {
    primary: params.primary,
    fallback: params.fallback,
    failedAt: now,
    lastProbeAt: previous?.lastProbeAt ?? now,
    reason: params.attempts?.[0]?.reason,
  });
  enforcePrimaryRecoveryStateCap();
}

export function recordPrimaryRecoveryOutcome(params: {
  candidates: ModelCandidate[];
  successfulCandidate: ModelCandidate;
  successfulIndex: number;
  attempts: FallbackAttempt[];
  agentDir?: string;
  now?: number;
}): void {
  const primary = params.candidates[0];
  if (!primary) {
    return;
  }
  if (sameCandidate(primary, params.successfulCandidate)) {
    recordPrimaryRecoverySuccess({ primary, agentDir: params.agentDir });
    return;
  }
  if (params.successfulIndex <= 0 || params.candidates.length <= 1) {
    return;
  }
  recordPrimaryRecoveryFallback({
    primary,
    fallback: params.successfulCandidate,
    attempts: params.attempts,
    agentDir: params.agentDir,
    now: params.now,
  });
}

export type PrimaryRecoveryRoutingDecision =
  | {
      type: "use_fallback";
      primary: ModelCandidate;
      fallback: ModelCandidate;
    }
  | {
      type: "probe_primary";
      primary: ModelCandidate;
    };

export function resolvePrimaryRecoveryRouting(params: {
  provider: string;
  model: string;
  fallbackCandidates: ModelCandidate[];
  agentDir?: string;
  now?: number;
}): PrimaryRecoveryRoutingDecision | null {
  const primary = normalizeCandidate(params.provider, params.model);
  const key = resolvePrimaryRecoveryKey(primary, params.agentDir);
  const now = params.now ?? Date.now();
  prunePrimaryRecoveryState(now);
  const state = primaryRecoveryState.get(key);
  if (!state) {
    return null;
  }
  const fallbackStillConfigured = params.fallbackCandidates.some((candidate) =>
    sameCandidate(candidate, state.fallback),
  );
  if (!fallbackStillConfigured) {
    primaryRecoveryState.delete(key);
    return null;
  }
  if (now - state.lastProbeAt >= PRIMARY_RECOVERY_PROBE_INTERVAL_MS) {
    primaryRecoveryState.set(key, {
      ...state,
      lastProbeAt: now,
    });
    return {
      type: "probe_primary",
      primary,
    };
  }
  return {
    type: "use_fallback",
    primary,
    fallback: state.fallback,
  };
}

/** @internal - exposed for focused regression tests only. */
export const _primaryRecoveryInternals = {
  primaryRecoveryState,
  PRIMARY_RECOVERY_PROBE_INTERVAL_MS,
  PRIMARY_RECOVERY_STATE_TTL_MS,
  MAX_PRIMARY_RECOVERY_KEYS,
  resolvePrimaryRecoveryKey,
  prunePrimaryRecoveryState,
} as const;
