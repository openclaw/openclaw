import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
} from "../openai-codex-routing.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";

export type HarnessAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileProvider: string;
  authProfileMode?: string;
};

export function profileIdProvider(profileId: string): string {
  return profileId.split(":", 1)[0] ?? "";
}

export function resolveOrderedOpenAIPiAuthProfileSelection(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  harnessId?: string;
  harnessRuntime?: string;
  allowHarnessAuthProfileForwarding: boolean;
}): HarnessAuthProfileSelection | undefined {
  const runtimeAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: params.provider,
    harnessRuntime: params.harnessRuntime,
    agentHarnessId: params.harnessId,
  });
  if (!runtimeAuthProviders.includes(OPENAI_CODEX_PROVIDER_ID)) {
    return undefined;
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const orderedCompatibleProfiles = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: OPENAI_CODEX_PROVIDER_ID,
  });

  const profileId = orderedCompatibleProfiles[0];
  if (!profileId || profileIdProvider(profileId) !== OPENAI_CODEX_PROVIDER_ID) {
    return undefined;
  }
  const credential = store.profiles[profileId];
  const candidateAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: credential?.provider ?? profileIdProvider(profileId),
    authProfileMode: credential?.type,
    sessionAuthProfileId: profileId,
    config: params.config,
    workspaceDir: params.workspaceDir,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
    allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding,
  });
  if (candidateAuthPlan.forwardedAuthProfileId === profileId) {
    return {
      authProfileId: profileId,
      authProfileIdSource: "auto",
      authProfileProvider: credential?.provider ?? profileIdProvider(profileId),
    };
  }

  return undefined;
}
