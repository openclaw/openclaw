/** Projects CLI-owned account readiness without borrowing provider credentials. */
import {
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import {
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-runner/cli-backend-auth-policy.js";
import type {
  createModelAuthAvailabilityResolver,
  ModelAuthAvailabilityRef,
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityResolver,
} from "./model-auth-availability.js";
import { resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases.js";

export function evaluateCliRuntimeModelAuthAvailability(
  params: Parameters<typeof createModelAuthAvailabilityResolver>[0],
  provider: string,
  ref: ModelAuthAvailabilityRef,
  evaluation: ModelAuthAvailabilityEvaluation,
  evaluateProviderAuth: ModelAuthAvailabilityResolver["evaluateModelAuth"],
): ModelAuthAvailabilityEvaluation | undefined {
  if (ref.runtimeId === "openclaw") {
    return undefined;
  }
  if (evaluation.routeResolution !== null || normalizeProviderId(provider) === "openai") {
    return undefined;
  }
  const selectedProfileId = ref.pinnedProfileId?.trim() || ref.preferredProfileId?.trim();
  // Direct CLI refs have no alias, but still own plugin and selected-account checks.
  const runtimeProvider =
    ref.runtimeId && ref.runtimeId !== "auto"
      ? ref.runtimeId
      : (resolveCliRuntimeExecutionProvider({
          provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: ref.modelId,
          authProfileId: selectedProfileId,
          metadataSnapshot: params.metadataSnapshot,
          preparedAuthDirectories: params.preparedCliRuntimeAuthDirectories,
        }) ?? normalizeProviderId(provider));
  const binding = resolveCliRuntimeModelBackendBinding({ provider, runtime: runtimeProvider });
  const runtimeOwners = params.metadataSnapshot?.owners?.cliBackends.get(
    normalizeProviderId(runtimeProvider),
  );
  // Agent harnesses can use provider auth without registering a CLI backend.
  if (
    !binding &&
    !runtimeOwners?.length &&
    !resolveCliRuntimeCanonicalProvider({ runtime: runtimeProvider })
  ) {
    return undefined;
  }
  if (ref.runtimeId && runtimeProvider !== normalizeProviderId(provider) && !binding) {
    return { availability: false, routeResolution: null, unavailableReason: "missing-auth" };
  }
  if (runtimeOwners?.length) {
    const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
    if (
      !runtimeOwners.some((pluginId) =>
        passesManifestOwnerBasePolicy({
          plugin: { id: pluginId },
          normalizedConfig: normalizedPluginConfig,
        }),
      )
    ) {
      return {
        ...evaluation,
        availability: false,
        unavailableReason: "missing-auth",
        unavailableUntil: undefined,
      };
    }
  }
  const authPolicy = resolveBundledCliBackendAuthPolicy(runtimeProvider);
  if (
    selectedProfileId &&
    authPolicy?.strictSelectedProfile &&
    !authPolicy.nativeAuthProfileIds?.includes(selectedProfileId)
  ) {
    // This CLI forbids account substitution while materializing selected auth.
    // Neither shared profiles nor its native login can rescue that selection.
    return ref.pinnedProfileId
      ? evaluateProviderAuth(provider, {
          modelId: ref.modelId,
          requiredProfileId: selectedProfileId,
        })
      : evaluation;
  }
  if (normalizeProviderId(runtimeProvider) === normalizeProviderId(provider)) {
    return runtimeOwners?.length ? evaluation : undefined;
  }
  const runtimeAuthMode =
    params.preparedRuntimeAuthModes?.[normalizeProviderIdForAuth(runtimeProvider)];
  // The prepared native-runtime result is authoritative for this route. Provider
  // credentials cannot prove that the separately authenticated CLI is usable.
  return typeof runtimeAuthMode === "string"
    ? {
        availability: true,
        routeResolution: null,
        selectedAuthMode: runtimeAuthMode,
        evidence: "runtime",
      }
    : params.preparedSyntheticAuthComplete
      ? { availability: false, routeResolution: null, unavailableReason: "missing-auth" }
      : { availability: undefined, routeResolution: null };
}
