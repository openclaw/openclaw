/**
 * Prepares model auth for embedded compaction runs and safeguard overrides.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { prepareProviderRuntimeAuth } from "../../plugins/provider-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import {
  getApiKeyForModel,
  MissingProviderAuthError,
  type ResolvedProviderAuth,
} from "../model-auth.js";
import { applyPreparedRuntimeAuthToModel } from "../provider-request-config.js";
import {
  protectPreparedProviderRuntimeAuth,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";

type RuntimeApiKeyStorage = {
  setRuntimeApiKey(provider: string, apiKey: string): void;
};

export type PreparedCompactionRuntimeAuth = {
  model: ProviderRuntimeModel;
  apiKeyInfo: ResolvedProviderAuth;
  authProfileId?: string;
  hasRuntimeAuthExchange: boolean;
};

/** Resolve profile auth, apply provider runtime overrides, and bind the runtime credential. */
export async function prepareCompactionRuntimeAuth(params: {
  model: ProviderRuntimeModel;
  modelId: string;
  config?: OpenClawConfig;
  authStorage: RuntimeApiKeyStorage;
  authProfileStore?: AuthProfileStore;
  authProfileId?: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<PreparedCompactionRuntimeAuth> {
  let model = params.model;
  const apiKeyInfo = await getApiKeyForModel({
    model,
    cfg: params.config,
    profileId: params.authProfileId,
    store: params.authProfileStore,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    secretSentinels: true,
  });

  if (!apiKeyInfo.apiKey) {
    if (apiKeyInfo.mode !== "aws-sdk") {
      throw new MissingProviderAuthError(model.provider, apiKeyInfo);
    }
    return {
      model,
      apiKeyInfo,
      authProfileId: apiKeyInfo.profileId ?? params.authProfileId,
      hasRuntimeAuthExchange: false,
    };
  }

  const preparedAuth = protectPreparedProviderRuntimeAuth({
    provider: model.provider,
    preparedAuth: await prepareProviderRuntimeAuth({
      provider: model.provider,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: process.env,
      context: {
        config: params.config,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
        env: process.env,
        provider: model.provider,
        modelId: params.modelId,
        model,
        apiKey: unwrapSecretSentinelsForProviderEgress(
          apiKeyInfo.apiKey,
          "provider runtime auth exchange",
        ),
        authMode: apiKeyInfo.mode,
        profileId: apiKeyInfo.profileId,
      },
    }),
  });
  model = applyPreparedRuntimeAuthToModel(model, preparedAuth);
  const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
  if (!runtimeApiKey) {
    throw new Error(`Provider "${model.provider}" runtime auth returned no apiKey.`);
  }
  params.authStorage.setRuntimeApiKey(model.provider, runtimeApiKey);

  return {
    model,
    apiKeyInfo,
    authProfileId: apiKeyInfo.profileId ?? params.authProfileId,
    hasRuntimeAuthExchange: Boolean(preparedAuth?.apiKey),
  };
}
