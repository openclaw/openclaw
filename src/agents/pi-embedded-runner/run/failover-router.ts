import type { FailoverReason } from "../../pi-embedded-helpers.js";

export type EmbeddedFailoverRouteDecision = "rotate_profile" | "fallback_model" | "surface_error";
export type EmbeddedFailoverRouteScope = "model" | "profile";

export type EmbeddedFailoverRouteInput = {
  provider: string;
  model: string;
  profileId?: string;
  reason: FailoverReason | null;
  canRotateProfile: boolean;
  fallbackConfigured: boolean;
};

export type EmbeddedFailoverRouteResult = {
  decision: EmbeddedFailoverRouteDecision;
  scope: EmbeddedFailoverRouteScope;
  circuitOpen: boolean;
  failureCount: number;
  threshold: number | null;
  key: string;
};

const MODEL_CIRCUIT_THRESHOLDS: Partial<Record<FailoverReason, number>> = {
  overloaded: 2,
  timeout: 2,
};

function buildFailureKey(params: {
  scope: EmbeddedFailoverRouteScope;
  provider: string;
  model: string;
  profileId?: string;
  reason: FailoverReason | null;
}) {
  const reason = params.reason ?? "unknown";
  if (params.scope === "model") {
    return `model:${params.provider}:${params.model}:${reason}`;
  }
  return `profile:${params.provider}:${params.model}:${params.profileId ?? "-"}:${reason}`;
}

function resolveScope(reason: FailoverReason | null): {
  scope: EmbeddedFailoverRouteScope;
  threshold: number | null;
} {
  if (!reason) {
    return {
      scope: "profile",
      threshold: null,
    };
  }
  const threshold = MODEL_CIRCUIT_THRESHOLDS[reason] ?? null;
  return {
    scope: threshold ? "model" : "profile",
    threshold,
  };
}

export function createEmbeddedFailoverRouter() {
  const failureCounts = new Map<string, number>();

  return {
    route(input: EmbeddedFailoverRouteInput): EmbeddedFailoverRouteResult {
      const { scope, threshold } = resolveScope(input.reason);
      const key = buildFailureKey({
        scope,
        provider: input.provider,
        model: input.model,
        profileId: input.profileId,
        reason: input.reason,
      });
      const failureCount = (failureCounts.get(key) ?? 0) + 1;
      failureCounts.set(key, failureCount);

      const circuitOpen = threshold !== null && failureCount >= threshold;
      const decision = (() => {
        if (circuitOpen && input.fallbackConfigured) {
          return "fallback_model";
        }
        if (input.canRotateProfile) {
          return "rotate_profile";
        }
        if (input.fallbackConfigured) {
          return "fallback_model";
        }
        return "surface_error";
      })();

      return {
        decision,
        scope,
        circuitOpen,
        failureCount,
        threshold,
        key,
      };
    },
  };
}
