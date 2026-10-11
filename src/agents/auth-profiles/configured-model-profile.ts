import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveNativeModelPrimary } from "../agent-scope.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import { resolveDefaultModelForAgent } from "../model-selection.js";
import { resolveModelCatalogIdentityKey } from "../openai-model-routes.js";

/**
 * The auth profile an agent's configured primary model pins with a trailing
 * `@profile`, when a session runs that same model. It carries user strength:
 * only a user pin on the session outranks it.
 */
export function resolveConfiguredModelAuthProfileId(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
}): string | undefined {
  const configuredProfile = splitTrailingAuthProfile(
    resolveNativeModelPrimary(params.cfg, params.agentId) ?? "",
  ).profile;
  if (!configuredProfile) {
    return undefined;
  }
  const defaultModel = resolveDefaultModelForAgent({ cfg: params.cfg, agentId: params.agentId });
  return resolveModelCatalogIdentityKey({
    provider: params.provider,
    id: splitTrailingAuthProfile(params.modelId).model,
  }) === resolveModelCatalogIdentityKey({ provider: defaultModel.provider, id: defaultModel.model })
    ? configuredProfile
    : undefined;
}
