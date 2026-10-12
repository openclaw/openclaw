import { selectApplicableRuntimeConfig } from "../config/config.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { prepareWebSearchConfiguration } from "../web-search/runtime.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "./agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfilesAsync } from "./auth-profiles/store-runtime.js";
import { resolveOptionalMediaToolFactoryPlan } from "./openclaw-tools.media-factory-plan.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";
import { hasGenerationToolAvailabilityAsync } from "./tools/media-tool-shared.js";
import { createOpenClawDelegateToolsForRunAsync } from "./tools/openclaw-delegate-tool.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export async function prepareOpenClawTools(
  options: OpenClawToolsOptions | undefined,
  shared: PreparedToolConstruction,
) {
  const captured = { ...options, config: shared.config };
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: captured.runSessionKey ?? captured.agentSessionKey,
    config: captured.config,
    agentId: captured.requesterAgentIdOverride,
  });
  captured.authProfileStore ??= captured.preparedModelRuntime
    ? getPreparedModelRuntimeAuthStore(captured.preparedModelRuntime)
    : undefined;
  captured.authProfileStore ??= await ensureAuthProfileStoreWithoutExternalProfilesAsync(
    captured.agentDir ?? resolveAgentDir(captured.config ?? {}, sessionAgentId),
    { allowKeychainPrompt: false },
  );
  const delegated = isEmbeddedMode()
    ? []
    : await createOpenClawDelegateToolsForRunAsync({ ...captured, sessionAgentId }, shared);
  shared.assertCurrent();
  captured.assertInvocationCurrent?.();
  const webSearchConfigured =
    captured.webSearchEnabled === false || captured.config?.tools?.web?.search?.enabled === false
      ? undefined
      : await prepareWebSearchConfiguration({
          config: captured.config,
          agentDir: captured.agentDir ?? resolveAgentDir(captured.config ?? {}, sessionAgentId),
          authStore: captured.authProfileStore,
          ...(captured.authProfileStoreSource !== undefined
            ? { resolveAuthProfileStoreSource: () => captured.authProfileStoreSource === true }
            : {}),
          runtimeWebSearch: getActiveRuntimeWebToolsMetadataFromState()?.search,
        });
  shared.assertCurrent();
  captured.assertInvocationCurrent?.();
  const runtimeSnapshot = getActiveSecretsRuntimeConfigSnapshot();
  const availabilityConfig =
    selectApplicableRuntimeConfig({
      inputConfig: captured.config,
      runtimeConfig: runtimeSnapshot?.config,
      runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
    }) ?? captured.config;
  const inferredWorkspaceDir =
    captured.workspaceDir || !captured.config
      ? undefined
      : resolveAgentWorkspaceDir(captured.config, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(captured.workspaceDir ?? inferredWorkspaceDir);
  const mediaPlan = resolveOptionalMediaToolFactoryPlan({
    config: availabilityConfig,
    workspaceDir,
    authStore: captured.authProfileStore,
    toolAllowlist: captured.pluginToolAllowlist,
    toolDenylist: captured.pluginToolDenylist,
    preparedModelRuntime: captured.preparedModelRuntime,
  });
  const prepareMediaAvailability = async (
    tool: "imageGenerate" | "videoGenerate" | "musicGenerate",
    providerKey:
      | "imageGenerationProviders"
      | "videoGenerationProviders"
      | "musicGenerationProviders",
    kind: "image" | "video" | "music",
  ) =>
    mediaPlan[tool] &&
    (await hasGenerationToolAvailabilityAsync({
      cfg: availabilityConfig,
      agentDir: captured.agentDir,
      workspaceDir,
      authStore: captured.authProfileStore,
      authProfileStoreSource: captured.authProfileStoreSource,
      modelConfig: availabilityConfig?.agents?.defaults?.mediaModels?.[kind],
      providerKey,
      providers: captured.preparedModelRuntime?.mediaCapabilityProviders?.[providerKey],
    }));
  const [imageGenerate, videoGenerate, musicGenerate] = await Promise.all([
    prepareMediaAvailability("imageGenerate", "imageGenerationProviders", "image"),
    prepareMediaAvailability("videoGenerate", "videoGenerationProviders", "video"),
    prepareMediaAvailability("musicGenerate", "musicGenerationProviders", "music"),
  ]);
  let personalInstructionsEnabled = false;
  if (!isEmbeddedMode()) {
    const profiles = await prepareUserProfileCatalog();
    try {
      personalInstructionsEnabled = profiles.hasMultipleSessionSharingIdentities();
    } finally {
      profiles.release();
    }
  }
  return {
    captured,
    delegated,
    webSearchConfigured,
    personalInstructionsEnabled,
    mediaTools: { ...mediaPlan, imageGenerate, videoGenerate, musicGenerate },
  };
}
