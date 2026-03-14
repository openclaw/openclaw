import { resolveFailoverStatus } from "../../failover-error.js";
import type { FailoverReason } from "../../pi-embedded-helpers.js";

type EmbeddedAttemptBreakerReason = Extract<FailoverReason, "overloaded" | "timeout">;

type EmbeddedAttemptRouterState = {
  provider: string;
  model: string;
  reason: EmbeddedAttemptBreakerReason;
  failureCount: number;
  threshold: number;
  status?: number;
  rawError: string;
  lastFailureAt: number;
  openUntil?: number;
};

export type EmbeddedAttemptRouterInspection = {
  provider: string;
  model: string;
  reason: EmbeddedAttemptBreakerReason;
  status?: number;
  rawError: string;
  failureCount: number;
  threshold: number;
  remainingMs: number;
};

export type EmbeddedAttemptRouterFailureRecord = {
  provider: string;
  model: string;
  reason: FailoverReason | null;
  status?: number;
  rawError: string;
};

export type EmbeddedAttemptRouterFailureResult = {
  circuitOpen: boolean;
  failureCount: number;
  threshold: number;
};

const BREAKER_REASONS: EmbeddedAttemptBreakerReason[] = ["overloaded", "timeout"];

const DEFAULT_BREAKER_THRESHOLDS: Record<EmbeddedAttemptBreakerReason, number> = {
  overloaded: 2,
  timeout: 2,
};

const DEFAULT_BREAKER_TTLS_MS: Record<EmbeddedAttemptBreakerReason, number> = {
  overloaded: 1_500,
  timeout: 1_500,
};

function isBreakerReason(reason: FailoverReason | null): reason is EmbeddedAttemptBreakerReason {
  return reason === "overloaded" || reason === "timeout";
}

function buildReasonKey(params: {
  provider: string;
  model: string;
  reason: EmbeddedAttemptBreakerReason;
}) {
  return `${params.provider}:${params.model}:${params.reason}`;
}

function buildOpenCircuitMessage(params: {
  provider: string;
  model: string;
  reason: EmbeddedAttemptBreakerReason;
  remainingMs: number;
}) {
  return (
    `embedded attempt circuit open for ${params.provider}/${params.model} ` +
    `after repeated ${params.reason} failures; retry in ${params.remainingMs}ms`
  );
}

export function createEmbeddedAttemptRouter(options?: {
  now?: () => number;
  breakerThresholds?: Partial<Record<EmbeddedAttemptBreakerReason, number>>;
  breakerTtlMs?: Partial<Record<EmbeddedAttemptBreakerReason, number>>;
}) {
  const now = options?.now ?? (() => Date.now());
  const breakerThresholds = {
    ...DEFAULT_BREAKER_THRESHOLDS,
    ...options?.breakerThresholds,
  };
  const breakerTtlMs = {
    ...DEFAULT_BREAKER_TTLS_MS,
    ...options?.breakerTtlMs,
  };
  const states = new Map<string, EmbeddedAttemptRouterState>();

  const clearExpired = (provider: string, model: string, currentNow: number) => {
    for (const reason of BREAKER_REASONS) {
      const key = buildReasonKey({ provider, model, reason });
      const state = states.get(key);
      if (!state) {
        continue;
      }
      if (state.openUntil !== undefined && state.openUntil <= currentNow) {
        states.delete(key);
      }
    }
  };

  return {
    inspect(input: { provider: string; model: string }): EmbeddedAttemptRouterInspection | null {
      const currentNow = now();
      clearExpired(input.provider, input.model, currentNow);
      for (const reason of BREAKER_REASONS) {
        const key = buildReasonKey({
          provider: input.provider,
          model: input.model,
          reason,
        });
        const state = states.get(key);
        if (!state || state.openUntil === undefined || state.openUntil <= currentNow) {
          continue;
        }
        const remainingMs = Math.max(1, state.openUntil - currentNow);
        return {
          provider: state.provider,
          model: state.model,
          reason: state.reason,
          status: state.status,
          rawError: buildOpenCircuitMessage({
            provider: state.provider,
            model: state.model,
            reason: state.reason,
            remainingMs,
          }),
          failureCount: state.failureCount,
          threshold: state.threshold,
          remainingMs,
        };
      }
      return null;
    },

    recordFailure(
      input: EmbeddedAttemptRouterFailureRecord,
    ): EmbeddedAttemptRouterFailureResult | null {
      if (!isBreakerReason(input.reason)) {
        return null;
      }
      const currentNow = now();
      const key = buildReasonKey({
        provider: input.provider,
        model: input.model,
        reason: input.reason,
      });
      const threshold = breakerThresholds[input.reason];
      const nextFailureCount = (states.get(key)?.failureCount ?? 0) + 1;
      const circuitOpen = nextFailureCount >= threshold;
      states.set(key, {
        provider: input.provider,
        model: input.model,
        reason: input.reason,
        failureCount: nextFailureCount,
        threshold,
        status: input.status ?? resolveFailoverStatus(input.reason),
        rawError: input.rawError,
        lastFailureAt: currentNow,
        ...(circuitOpen ? { openUntil: currentNow + breakerTtlMs[input.reason] } : {}),
      });
      return {
        circuitOpen,
        failureCount: nextFailureCount,
        threshold,
      };
    },

    recordSuccess(input: { provider: string; model: string }) {
      for (const reason of BREAKER_REASONS) {
        states.delete(
          buildReasonKey({
            provider: input.provider,
            model: input.model,
            reason,
          }),
        );
      }
    },
  };
}
