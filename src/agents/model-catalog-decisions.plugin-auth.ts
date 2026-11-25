import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolvePluginOwnedProviderAuthWith } from "../plugins/provider-auth-scope.js";
import { resolveLoadedProviderRuntimePlugin } from "../plugins/provider-hook-runtime.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import type { CreateModelAuthAvailabilityResolverParams } from "./model-auth-availability.types.js";
import { isAuthModeAllowedForModel } from "./model-auth-policy.js";

/** Plugin-owned auth hooks for the catalog availability resolver, bound to one plugin generation. */
export function createCatalogPluginAuth({
  cfg,
  workspaceDir,
  metadataSnapshot,
  pluginRegistry,
}: {
  cfg: OpenClawConfig;
  workspaceDir: string | undefined;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry: PluginRegistry | undefined;
}): Pick<
  CreateModelAuthAvailabilityResolverParams,
  "evaluatePluginAuth" | "canRefreshProviderOAuth"
> {
  return {
    evaluatePluginAuth: (provider, ref) => {
      if (!pluginRegistry) {
        return { availability: undefined, routeResolution: null, availabilityAuthoritative: true };
      }
      try {
        return withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, () => {
          const auth = resolvePluginOwnedProviderAuthWith(
            {
              provider,
              config: cfg,
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
        });
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
    // Mirrors the runtime OAuth manager, which refreshes through the loaded provider plugin.
    canRefreshProviderOAuth: (provider) => {
      if (!pluginRegistry) {
        return false;
      }
      try {
        return withPluginRuntimeGenerationScope(
          { metadataSnapshot, pluginRegistry },
          () =>
            typeof resolveLoadedProviderRuntimePlugin({
              provider,
              config: cfg,
              workspaceDir,
            })?.refreshOAuth === "function",
        );
      } catch {
        return false;
      }
    },
  };
}
