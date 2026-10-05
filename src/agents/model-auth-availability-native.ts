import type { ProviderModelRouteResolution } from "../plugin-sdk/provider-model-types.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.types.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";

/** Native command auth is a declared Codex runtime source, never a host bearer. */
export function codexNativeRouteAvailability(params: {
  routeResolution: Extract<ProviderModelRouteResolution, { kind: "routes" }>;
  nativeCommandAuth: boolean;
  nativeAuth?: unknown;
  preparedSyntheticAuthComplete?: boolean;
}): ModelAuthAvailabilityEvaluation {
  const native = params.nativeAuth;
  const nativeMode =
    typeof native === "object" &&
    native !== null &&
    "source" in native &&
    native.source === "native" &&
    "mode" in native &&
    typeof native.mode === "string"
      ? native.mode
      : undefined;
  const mode = params.nativeCommandAuth ? "native-command" : nativeMode;
  const requirement = params.nativeCommandAuth
    ? "api-key"
    : resolveProviderModelRouteAuthRequirement(nativeMode);
  const selectedRoute = requirement
    ? params.routeResolution.routes.find((route) => route.authRequirement === requirement)
    : undefined;
  return {
    availability: mode
      ? Boolean(selectedRoute)
      : params.preparedSyntheticAuthComplete
        ? false
        : undefined,
    availabilityAuthoritative: true,
    routeResolution: params.routeResolution,
    ...(selectedRoute
      ? { selectedRoute, selectedAuthMode: mode }
      : { unavailableReason: "missing-auth" }),
    evidence: "runtime",
    runtimeAuth: { id: "codex", source: "native" },
  };
}
