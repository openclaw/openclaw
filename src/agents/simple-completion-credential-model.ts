// Credential-aware inputs of simple-completion model preparation: which auth store is read, and
// which account a credential-scoped model belongs to.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { ensureAuthProfileStoreAsync } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { resolveProviderModelAuthPolicy } from "./model-auth-policy.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import { resolveModelRouteIntent } from "./model-runtime-policy.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveOpenAIModelRoutes } from "./openai-model-routes.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";
import { providerUsesCredentialScopedModelMetadata } from "./runtime-plan/credential-scoped-model.js";
import { prepareAgentRuntimeAuth } from "./runtime-plan/prepare-auth.js";
import type { SimpleCompletionModelResolver } from "./simple-completion-scope.js";

/** A caller-supplied store wins. Plugin-owned credentials never open an agent store. */
export async function resolveSimpleCompletionAuthStore(params: {
  provider: string;
  pluginOwnedAuth: boolean;
  authStore?: AuthProfileStore;
  onAuthProfiles?: unknown;
  bindAuthOwner?: boolean;
  cfg?: OpenClawConfig;
  agentDir?: string;
  profileId?: string;
}): Promise<AuthProfileStore | undefined> {
  if (params.pluginOwnedAuth) {
    return undefined;
  }
  const readsStore = params.onAuthProfiles || params.bindAuthOwner || params.provider === "openai";
  if (params.authStore || !readsStore) {
    return params.authStore;
  }
  return await ensureAuthProfileStoreAsync(params.agentDir, {
    readOnly: true,
    allowKeychainPrompt: false,
    config: params.cfg,
    profileId: params.profileId,
  });
}

/** Use the same route and account input for both auth admission and model resolution. */
export function prepareSimpleCompletionRuntimeAuth(params: {
  auth: Parameters<typeof prepareAgentRuntimeAuth>[0];
  agentRuntimeId?: string;
  profileId?: string;
  requiresPreparedAuth: boolean;
}) {
  const { auth, agentRuntimeId, profileId } = params;
  const { config, provider, modelId, modelApi, modelBaseUrl, agentId, authProfileStore } = auth;
  const primaryModel = config
    ? resolveDefaultModelForAgent({
        cfg: config,
        agentId,
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      })
    : undefined;
  const resolveProfileAuthMode = (id: string) => authProfileStore?.profiles[id]?.type;
  const resolveProfileAuthFlow = (id: string) => {
    const credential = authProfileStore?.profiles[id];
    return credential?.type === "oauth" ? credential.authFlow : undefined;
  };
  const routeIntent = agentRuntimeId
    ? { runtimeId: agentRuntimeId, source: "explicit" as const }
    : resolveModelRouteIntent({
        config,
        provider,
        modelId,
        agentId,
        primaryModel,
        resolveProfileAuthMode,
        resolveProfileAuthFlow,
      });
  const routeResolution = resolveOpenAIModelRoutes({
    provider,
    modelId,
    api: modelApi,
    baseUrl: modelBaseUrl,
    config,
    agentId,
    routeIntent,
    resolveProfileAuthMode,
    resolveProfileAuthFlow,
    pinnedAuthRequirement: profileId
      ? (resolveProviderModelAuthPolicy({
          provider,
          mode: resolveProfileAuthMode(profileId),
          authFlow: resolveProfileAuthFlow(profileId),
        }).authRequirement ?? undefined)
      : undefined,
    env: process.env,
  });
  return params.requiresPreparedAuth || routeResolution?.kind === "routes"
    ? prepareAgentRuntimeAuth({ ...auth, routeIntent })
    : undefined;
}

/**
 * Some providers scope model limits and transport to the account. Resolve the model again for the
 * selected credential. The credential's mode is passed with its profile id, so discovery does not
 * read the agent store again and a profile that only the caller's store holds keeps working.
 */
export async function resolveModelForSelectedCredential(params: {
  model: Model;
  auth: ResolvedProviderAuth;
  cfg?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  modelResolver: SimpleCompletionModelResolver;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): Promise<Model> {
  const { model, auth } = params;
  if (
    !providerUsesCredentialScopedModelMetadata({
      provider: model.provider,
      modelId: model.id,
      config: params.cfg,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
    })
  ) {
    return model;
  }
  const authProfileMode = resolveProviderModelMaterializationAuthMode(auth.mode);
  const authoritative = await params.modelResolver(
    model.provider,
    model.id,
    params.agentDir,
    params.cfg,
    {
      abortSignal: params.signal,
      assertCurrent: params.assertCurrent,
      modelIdSource: "selected",
      ...(params.agentId ? { agentId: params.agentId } : {}),
      skipAgentDiscovery: true,
      allowBundledStaticCatalogFallback: true,
      ...(auth.profileId ? { authProfileId: auth.profileId } : {}),
      ...(authProfileMode ? { authProfileMode } : {}),
    },
  );
  return authoritative.model ?? model;
}
