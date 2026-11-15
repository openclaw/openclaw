import type { ProviderModelRouteResolution } from "../plugin-sdk/provider-model-types.js";
import type {
  AuthSourceEvaluation,
  AuthTarget,
  ModelAuthAvailabilityEvaluation,
} from "./model-auth-availability.types.js";
import type { selectOpenAIModelRouteAuth } from "./openai-model-routes.js";
import type { ProviderModelAuthSourcePlan } from "./provider-model-auth-source-plan.js";
import {
  resolveProviderModelRouteAuthRequirement,
  type ProviderModelAuthSourceSelection,
} from "./provider-model-route-auth.js";

type OpenAIRouteAuthDecision = ReturnType<typeof selectOpenAIModelRouteAuth>;

/** Projects selected or rejected routes after runtime-owned auth has been handled. */
export function projectOpenAIModelAuth({
  routeAuthDecision,
  routeResolution,
  sourcePlan,
  ref,
  directUnavailableReason,
  hasDirectFallback,
  syntheticCodexOwnsAuth,
  evaluateSource,
  evaluateRejectedSource,
}: {
  routeAuthDecision: OpenAIRouteAuthDecision;
  routeResolution: Extract<ProviderModelRouteResolution, { kind: "routes" }>;
  sourcePlan: ProviderModelAuthSourcePlan;
  ref: AuthTarget;
  directUnavailableReason: AuthSourceEvaluation["unavailableReason"];
  hasDirectFallback: boolean;
  syntheticCodexOwnsAuth: boolean;
  evaluateSource: (
    selection: ProviderModelAuthSourceSelection,
    target: AuthTarget,
  ) => AuthSourceEvaluation;
  evaluateRejectedSource: (
    reason: Extract<OpenAIRouteAuthDecision, { kind: "rejected" }>["reason"],
    target: AuthTarget,
  ) => AuthSourceEvaluation;
}): ModelAuthAvailabilityEvaluation {
  if (routeAuthDecision.kind !== "selected") {
    const rejectedSource =
      routeAuthDecision.kind === "rejected" ? routeAuthDecision.source : undefined;
    const projectRejectedSource =
      routeAuthDecision.kind === "rejected" &&
      rejectedSource &&
      (routeAuthDecision.reason === "all-cooldown" || rejectedSource.readiness === "unavailable")
        ? rejectedSource
        : undefined;
    const rejectedRequirement = resolveProviderModelRouteAuthRequirement(
      rejectedSource?.mode,
      rejectedSource?.authRequirement,
    );
    const rejectedRoute =
      routeAuthDecision.kind === "rejected" ? routeAuthDecision.route : undefined;
    const rejectedSourceRoute = rejectedRequirement
      ? routeResolution.routes.find(
          (candidate) => candidate.authRequirement === rejectedRequirement,
        )
      : undefined;
    const selectedRoute =
      rejectedRoute ??
      rejectedSourceRoute ??
      (routeResolution.routes.length === 1 ? routeResolution.routes[0] : undefined);
    return {
      ...(routeAuthDecision.kind === "rejected"
        ? evaluateRejectedSource(routeAuthDecision.reason, {
            ...ref,
            authRequirement:
              rejectedRoute?.authRequirement ??
              (routeResolution.routes.length === 1 ? selectedRoute?.authRequirement : undefined),
          })
        : { availability: false }),
      ...(sourcePlan.kind === "automatic" &&
      sourcePlan.profiles.kind === "empty" &&
      !sourcePlan.profiles.explicitOrder &&
      !hasDirectFallback
        ? { unavailableReason: directUnavailableReason }
        : {}),
      routeResolution,
      ...(routeAuthDecision.kind === "rejected" && routeAuthDecision.authModeIncompatible
        ? { availabilityAuthoritative: true as const }
        : {}),
      ...(projectRejectedSource
        ? {
            selectedProfileId: projectRejectedSource.profileId,
            selectedAuthMode: projectRejectedSource.mode,
            evidence: "profile" as const,
          }
        : {}),
      ...(selectedRoute ? { selectedRoute } : {}),
    };
  }
  const selectedRoute = routeAuthDecision.selection.route;
  const evaluation = evaluateSource(routeAuthDecision.selection, { ...ref, ...selectedRoute });
  const syntheticSubscriptionRoute = routeResolution.routes.find(
    (route) => route.authRequirement === "subscription",
  );
  if (syntheticCodexOwnsAuth && evaluation.availability !== true && syntheticSubscriptionRoute) {
    return {
      availability: undefined,
      routeResolution,
      evidence: "synthetic",
    };
  }
  return {
    ...evaluation,
    availability: evaluation.availability ?? (evaluation.evidence ? undefined : false),
    routeResolution,
    selectedRoute,
  };
}
