/** CLI-runtime availability follows execution's forwarded account or native login. */
import {
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { passesManifestOwnerBasePolicy } from "../plugins/manifest-owner-policy.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PreparedAgentCredentialModes } from "./agent-auth-credential-modes.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  resolveCliRuntimeCanonicalProvider,
  resolveCliRuntimeModelBackendBinding,
} from "./cli-backends.js";
import { selectCliExecutionAuthProfile } from "./cli-execution-auth.js";
import { resolveBundledCliBackendAuthPolicy } from "./cli-runner/cli-backend-auth-policy.js";
import type {
  ModelAuthAvailabilityEvaluation,
  ModelAuthAvailabilityRef,
  ModelAuthAvailabilityResolver,
} from "./model-auth-availability.types.js";
import {
  resolveCliRuntimeExecutionProvider,
  type CliRuntimeAuthDirectories,
} from "./model-runtime-aliases.js";
import {
  collectPreparedModelRuntimeConfiguredRefs,
  collectPreparedModelRuntimeProviderIds,
} from "./prepared-model-runtime.configured.js";

/** Builds one resolver's CLI-runtime evaluator; undefined leaves provider auth in charge. */
export function createCliRuntimeModelAuthEvaluator(
  params: {
    cfg: OpenClawConfig;
    authStore: AuthProfileStore;
    agentId?: string;
    metadataSnapshot?: PluginMetadataSnapshot;
    preparedCliRuntimeAuthDirectories?: CliRuntimeAuthDirectories;
    preparedRuntimeAuthModes?: PreparedAgentCredentialModes;
    preparedSyntheticAuthComplete?: boolean;
  },
  evaluateProviderAuth: ModelAuthAvailabilityResolver["evaluateModelAuth"],
) {
  let configuredRuntimes: ReadonlySet<string> | undefined;
  return (
    provider: string,
    ref: ModelAuthAvailabilityRef,
    evaluation: ModelAuthAvailabilityEvaluation,
  ): ModelAuthAvailabilityEvaluation | undefined => {
    if (ref.runtimeId === "openclaw" || evaluation.routeResolution !== null) {
      return undefined;
    }
    const normalizedProvider = normalizeProviderId(provider);
    if (normalizedProvider === "openai") {
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
          }) ?? normalizedProvider);
    const normalizedRuntimeProvider = normalizeProviderId(runtimeProvider);
    const binding = resolveCliRuntimeModelBackendBinding({ provider, runtime: runtimeProvider });
    const runtimeOwners =
      params.metadataSnapshot?.owners?.cliBackends.get(normalizedRuntimeProvider);
    // Agent harnesses can use provider auth without registering a CLI backend.
    if (
      !binding &&
      !runtimeOwners?.length &&
      !resolveCliRuntimeCanonicalProvider({ runtime: runtimeProvider })
    ) {
      return undefined;
    }
    if (ref.runtimeId && runtimeProvider !== normalizedProvider && !binding) {
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
    if (!selectedProfileId && authPolicy?.strictSelectedProfile) {
      const profile = selectCliExecutionAuthProfile({
        cliExecutionProvider: runtimeProvider,
        authProfileProvider: provider,
        model: ref.modelId,
        config: params.cfg,
        store: params.authStore,
        readinessMode: "read-only",
        metadataSnapshot: params.metadataSnapshot,
      });
      if (profile) {
        return evaluateProviderAuth(profile.provider, {
          modelId: ref.modelId,
          requiredProfileId: profile.profileId,
        });
      }
    }
    const runtimeAuth = { id: runtimeProvider, source: "native" as const };
    if (normalizedRuntimeProvider === normalizedProvider) {
      return runtimeOwners?.length ? { ...evaluation, runtimeAuth } : undefined;
    }
    const runtimeAuthMode =
      params.preparedRuntimeAuthModes?.[normalizeProviderIdForAuth(runtimeProvider)];
    if (runtimeAuthMode !== undefined) {
      // Without a forwarded account, the prepared native login owns readiness.
      return {
        availability: true,
        routeResolution: null,
        selectedAuthMode:
          typeof runtimeAuthMode === "string" ? runtimeAuthMode : runtimeAuthMode.mode,
        evidence: "runtime",
        runtimeAuth,
      };
    }
    // Preparation probes the native login of every configured runtime; only routes found by
    // later discovery wait for the full catalog's probe (#134463).
    configuredRuntimes ??= new Set(
      collectPreparedModelRuntimeProviderIds(
        params.cfg,
        {},
        false,
        collectPreparedModelRuntimeConfiguredRefs(params.cfg, params.agentId),
        params.agentId,
      ),
    );
    return params.preparedSyntheticAuthComplete || configuredRuntimes.has(normalizedRuntimeProvider)
      ? {
          availability: false,
          routeResolution: null,
          unavailableReason: "missing-auth",
          runtimeAuth,
        }
      : { availability: undefined, routeResolution: null, runtimeAuth };
  };
}
