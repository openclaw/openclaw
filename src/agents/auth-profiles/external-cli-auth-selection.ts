import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { CLAUDE_CLI_PROFILE_ID } from "./constants.js";
import { resolveExplicitAuthOrderSelection } from "./explicit-order.js";
import type { AuthProfileStore } from "./types.js";

const CLAUDE_CLI_PROVIDER_ID = "claude-cli";

export function resolveExternalCliAuthOverlayScopeFromSelection(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentId?: string;
  modelId?: string;
  workspaceDir?: string;
  store?: AuthProfileStore;
  userPinnedAuthProfileId?: string;
}): {
  providerIds?: readonly string[];
  ignoreAutoPreferredProfile: boolean;
} {
  const authProvider = params.provider;
  const authConfig = params.cfg;
  const authWorkspaceDir = params.workspaceDir;
  const authStore = params.store;
  const pinnedProfileId = params.userPinnedAuthProfileId;
  const discoveredProviderIds: string[] = [];
  const orderProviderAuthKey = resolveProviderIdForAuth(authProvider, {
    config: authConfig,
    workspaceDir: authWorkspaceDir,
  });
  const requestedProfileIds =
    resolveExplicitAuthOrderSelection({
      storeOrder: authStore?.order,
      configuredOrder: authConfig?.auth?.order,
      providerKey: authProvider,
      providerAuthKey: orderProviderAuthKey,
    }).order ?? [];
  const orderedProfileIds = [
    ...new Set(
      requestedProfileIds
        .map((profileId) => profileId?.trim())
        .filter((profileId): profileId is string => Boolean(profileId)),
    ),
  ];
  const allProfileIds = [
    ...new Set([
      ...Object.keys(authConfig?.auth?.profiles ?? {}),
      ...Object.keys(authStore?.profiles ?? {}),
    ]),
  ];
  const discoveredProfileIds = orderedProfileIds.length > 0 ? orderedProfileIds : allProfileIds;
  const profileIds = pinnedProfileId
    ? [
        pinnedProfileId,
        ...discoveredProfileIds.filter((profileId) => profileId !== pinnedProfileId),
      ]
    : discoveredProfileIds;
  let selectedProviderId: string | undefined;
  let compatibleProfileCount = 0;
  for (const profileId of profileIds) {
    const profile = authConfig?.auth?.profiles?.[profileId];
    const credential = authStore?.profiles?.[profileId];
    const profileProvider =
      profile?.provider ??
      credential?.provider ??
      (profileId === CLAUDE_CLI_PROFILE_ID ? CLAUDE_CLI_PROVIDER_ID : undefined);
    if (!profileProvider) {
      continue;
    }
    const authAliasParams = {
      config: authConfig,
      workspaceDir: authWorkspaceDir,
    };
    const providerAuthKey = resolveProviderIdForAuth(authProvider, authAliasParams);
    const profileAuthKey = resolveProviderIdForAuth(profileProvider, {
      ...authAliasParams,
      storedCredential: true,
    });
    if (!providerAuthKey || profileAuthKey !== providerAuthKey) {
      continue;
    }
    const externalCliProviderId =
      normalizeProviderId(profileProvider) === CLAUDE_CLI_PROVIDER_ID
        ? CLAUDE_CLI_PROVIDER_ID
        : undefined;
    compatibleProfileCount += 1;
    if (compatibleProfileCount === 1) {
      selectedProviderId = externalCliProviderId;
    }
    if (externalCliProviderId) {
      discoveredProviderIds.push(externalCliProviderId);
    }
  }
  const authScopeProviderIds = [...new Set(discoveredProviderIds)];
  if (!pinnedProfileId && orderedProfileIds.length === 0) {
    // Without explicit order, select only when compatibility is unambiguous.
    selectedProviderId = compatibleProfileCount === 1 ? authScopeProviderIds[0] : undefined;
  }
  const selectedRuntimeProvider =
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: params.modelId,
      authProfileId: params.userPinnedAuthProfileId,
    }) || (params.provider === CLAUDE_CLI_PROVIDER_ID ? CLAUDE_CLI_PROVIDER_ID : undefined);
  const selectedProvider =
    selectedProviderId ??
    (selectedRuntimeProvider === CLAUDE_CLI_PROVIDER_ID ? CLAUDE_CLI_PROVIDER_ID : undefined);
  const providerIds = [
    ...new Set([
      ...authScopeProviderIds,
      ...(selectedRuntimeProvider === CLAUDE_CLI_PROVIDER_ID ? [CLAUDE_CLI_PROVIDER_ID] : []),
    ]),
  ];
  return {
    ...(providerIds.length > 0 ? { providerIds } : {}),
    ignoreAutoPreferredProfile:
      // Claude CLI should not auto-prefer a profile when runtime selection has
      // already chosen Claude CLI and the user did not pin a profile.
      !params.userPinnedAuthProfileId && selectedProvider === CLAUDE_CLI_PROVIDER_ID,
  };
}
