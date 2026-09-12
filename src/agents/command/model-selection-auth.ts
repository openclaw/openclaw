import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { shouldPreserveUnavailableSessionAuthProfileOverride } from "../../sessions/auth-profile-preservation.js";
import { resolveAgentDir } from "../agent-scope.js";
import { isStoredCredentialCompatibleWithAuthProvider } from "../auth-profiles/order.js";
import { clearSessionAuthProfileOverride } from "../auth-profiles/session-override.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { resolveAvailableAgentHarnessPolicy } from "../harness/selection.js";
import { resolveModelProviderAuthConfig } from "../model-auth-provider-route.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";

export async function resolveCommandSessionAuth(
  params: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    defaultProvider: string;
    workspaceDir: string;
    pluginsEnabled: boolean;
    manifestMetadataSnapshot?: PluginMetadataSnapshot;
    sessionAgentId: string;
    sessionKey?: string;
    sessionStore?: Record<string, SessionEntry>;
    storePath: string;
    suppressVisibleSessionEffects: boolean;
    preserveStoredSelection: boolean;
  },
  initialEntry?: SessionEntry,
) {
  let sessionEntry = initialEntry;
  const authProfileId = sessionEntry?.authProfileOverride;
  if (sessionEntry && authProfileId) {
    const entry = sessionEntry;
    const authConfig = resolveModelProviderAuthConfig({
      config: params.cfg,
      provider: params.provider,
      modelId: params.model,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    const agentDir = resolveAgentDir(params.cfg, params.sessionAgentId);
    const store = ensureAuthProfileStore(agentDir, {
      profileId: authProfileId,
      config: params.cfg,
      allowKeychainPrompt: false,
    });
    const profile = store.profiles[authProfileId];
    const validationHarnessPolicy = resolveAvailableAgentHarnessPolicy({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      agentId: params.sessionAgentId,
      sessionKey: params.sessionKey,
    });
    const authAliasLookupParams = params.pluginsEnabled
      ? {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          ...(params.manifestMetadataSnapshot
            ? { metadataSnapshot: params.manifestMetadataSnapshot }
            : {}),
        }
      : {
          config: authConfig,
          workspaceDir: params.workspaceDir,
          metadataSnapshot: { plugins: [] },
        };
    const acceptedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
      provider: params.provider,
      harnessRuntime: validationHarnessPolicy.runtime,
      config: params.cfg,
    }).map((candidateProvider) =>
      params.pluginsEnabled
        ? resolveProviderIdForAuth(candidateProvider, authAliasLookupParams)
        : candidateProvider,
    );
    const profileMatchesRuntime =
      profile &&
      acceptedAuthProviders.some((candidateProvider) =>
        isStoredCredentialCompatibleWithAuthProvider({
          cfg: authConfig,
          authAliasLookupParams,
          provider: candidateProvider,
          credential: profile,
        }),
      );
    const preserveUnavailableSelection = shouldPreserveUnavailableSessionAuthProfileOverride({
      store,
      cfg: authConfig,
      agentDir,
      entry,
      currentProvider: entry.providerOverride ?? params.defaultProvider,
      provider: params.provider,
      metadataSnapshot: params.pluginsEnabled ? params.manifestMetadataSnapshot : { plugins: [] },
    });
    if (!profileMatchesRuntime && !preserveUnavailableSelection) {
      if (params.preserveStoredSelection) {
        sessionEntry = {
          ...entry,
          authProfileOverride: undefined,
          authProfileOverrideSource: undefined,
          authProfileOverrideCompactionCount: undefined,
        };
      } else if (
        params.sessionStore &&
        params.sessionKey &&
        !params.suppressVisibleSessionEffects
      ) {
        await clearSessionAuthProfileOverride({
          sessionEntry: entry,
          sessionStore: params.sessionStore,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        });
      }
    }
  }

  return sessionEntry;
}
