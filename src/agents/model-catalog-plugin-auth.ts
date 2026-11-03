import { resolvePluginOwnedProviderAuthWith } from "../plugins/provider-auth-scope.js";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { createModelAuthAvailabilityResolver } from "./model-auth-availability.js";
import { isAuthModeAllowedForModel } from "./model-auth-policy.js";
import type { ModelCatalogDecisionParams } from "./model-catalog-decisions.types.js";

/** Keep refresh capability and credential evaluation on the same prepared plugin generation. */
export function createCatalogPluginAuthCallbacks(
  params: Pick<ModelCatalogDecisionParams, "cfg" | "pluginRegistry" | "metadataSnapshot">,
  workspaceDir: string,
): Pick<
  Parameters<typeof createModelAuthAvailabilityResolver>[0],
  "canRefreshProviderOAuth" | "evaluatePluginAuth"
> {
  const metadataSnapshot = params.metadataSnapshot;
  return {
    canRefreshProviderOAuth: (provider) => {
      if (!params.pluginRegistry) {
        return false;
      }
      try {
        return withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: params.pluginRegistry },
          () =>
            typeof resolveLoadedProviderRuntimePlugin({
              provider,
              config: params.cfg,
              workspaceDir,
            })?.refreshOAuth === "function",
        );
      } catch {
        return false;
      }
    },
    evaluatePluginAuth: (provider, ref) => {
      if (!params.pluginRegistry) {
        return { availability: undefined, routeResolution: null, availabilityAuthoritative: true };
      }
      try {
        return withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry: params.pluginRegistry },
          () => {
            const auth = resolvePluginOwnedProviderAuthWith(
              {
                provider,
                config: params.cfg,
                workspaceDir,
                pluginMetadataSnapshot: metadataSnapshot,
                profileId: ref.requiredProfileId ?? ref.pinnedProfileId,
                preferredProfile: ref.preferredProfileId,
              },
              resolveLoadedProviderRuntimePlugin,
            );
            // Credential and model policy must observe the same prepared owner generation.
            const compatible =
              isAuthModeAllowedForModel({
                provider,
                mode: auth.mode,
                modelApi: ref.api ?? undefined,
                modelBaseUrl: typeof ref.baseUrl === "string" ? ref.baseUrl : undefined,
              }) &&
              (!auth.nativeAuth || auth.nativeAuth.runtime === ref.runtimeId);
            return {
              availability: compatible,
              selectedAuthMode: auth.mode,
              ...(compatible && auth.nativeAuth
                ? { runtimeAuth: { id: auth.nativeAuth.runtime, source: "native" as const } }
                : {}),
              evidence: "runtime" as const,
              routeResolution: null,
              availabilityAuthoritative: true as const,
            };
          },
        );
      } catch {
        return {
          availability: false,
          unavailableReason: "missing-auth",
          evidence: "runtime",
          routeResolution: null,
          availabilityAuthoritative: true,
        };
      }
    },
  };
}
