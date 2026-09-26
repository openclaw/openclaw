import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";

type HarnessAuthProfileSelection = {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
  authProfileProvider: string;
  authProfileMode?: string;
};

function resolveProfileAuthFromStore(params: { agentDir: string; profileId: string | undefined }): {
  provider?: string;
  mode?: string;
} {
  const profileId = params.profileId?.trim();
  if (!profileId) {
    return {};
  }
  const credential = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    externalCliProfileIds: [profileId],
  }).profiles[profileId];
  return { provider: credential?.provider, mode: credential?.type };
}

export function resolveHarnessAuthProfileSelection(params: {
  config: OpenClawConfig;
  agentDir: string;
  workspaceDir: string;
  provider: string;
  authProfileProvider: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user";
  harnessId?: string;
  harnessRuntime?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  providerAuthAliasesEnabled?: boolean;
  allowHarnessAuthProfileForwarding: boolean;
}): HarnessAuthProfileSelection {
  const sessionAuthProfileId = params.sessionAuthProfileId?.trim();
  if (sessionAuthProfileId) {
    const profileAuth = resolveProfileAuthFromStore({
      agentDir: params.agentDir,
      profileId: sessionAuthProfileId,
    });
    return {
      authProfileId: sessionAuthProfileId,
      authProfileIdSource: params.sessionAuthProfileSource,
      authProfileProvider: profileAuth.provider ?? params.authProfileProvider,
      authProfileMode: profileAuth.mode,
    };
  }

  if (!params.allowHarnessAuthProfileForwarding) {
    return { authProfileProvider: params.authProfileProvider };
  }

  const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
    provider: params.provider,
    authProfileProvider: params.authProfileProvider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    ...(params.metadataSnapshot ? { metadataSnapshot: params.metadataSnapshot } : {}),
    providerAuthAliasesEnabled: params.providerAuthAliasesEnabled,
    harnessId: params.harnessId,
    harnessRuntime: params.harnessRuntime,
    allowHarnessAuthProfileForwarding: params.allowHarnessAuthProfileForwarding,
  });
  const harnessAuthProvider = runtimeAuthPlan.harnessAuthProvider;
  if (!harnessAuthProvider) {
    return { authProfileProvider: params.authProfileProvider };
  }

  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
    externalCliProviderIds: [harnessAuthProvider],
  });
  const authProfileId = resolveAuthProfileOrder({
    cfg: params.config,
    store,
    provider: harnessAuthProvider,
  })[0];

  return authProfileId
    ? {
        authProfileId,
        authProfileIdSource: "auto",
        authProfileProvider: harnessAuthProvider,
      }
    : { authProfileProvider: params.authProfileProvider };
}
