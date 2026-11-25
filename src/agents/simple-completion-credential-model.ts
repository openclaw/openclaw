// Credential-aware inputs of simple-completion model preparation: which auth store is read, and
// which account a credential-scoped model belongs to.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { Model } from "../llm/types.js";
import { ensureAuthProfileStoreAsync } from "./auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ResolvedProviderAuth } from "./model-auth.js";
import { resolveProviderModelMaterializationAuthMode } from "./provider-model-route-auth.js";
import { providerUsesCredentialScopedModelMetadata } from "./runtime-plan/credential-scoped-model.js";
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
