import {
  assertContextEngineHostSupport,
  CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
  embeddedAgentLog,
  loadCodexBundleMcpThreadConfig,
  supportsModelTools,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexMcpToolOverridesForAgent } from "openclaw/plugin-sdk/codex-mcp-projection";
import { prepareCodexAppServerAuthBinding } from "./auth-binding.js";
import { resolveCodexAppServerAuthAccountCacheKey } from "./auth-bridge.js";
import {
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-cache-key.js";
import { isCodexSandboxExecServerEnabled } from "./config.js";
import {
  resolveCodexAppServerHookChannelId,
  shouldEnableCodexAppServerNativeToolSurface,
} from "./dynamic-tool-build.js";
import {
  assertCodexNativeHookRelayAllowed,
  CodexManagedHooksOnlyError,
} from "./native-hook-relay.js";
import { resolveCodexProviderWebSearchSupport } from "./provider-capabilities.js";
import { isCodexResponsesOAuth } from "./responses-oauth.js";
import { prewarmCodexAttemptClient } from "./run-attempt-client-prewarm.js";
import type { CodexAttemptConnection } from "./run-attempt-connection.js";
import {
  assertScheduledCodexAppAuthorityRuntime,
  buildLegacyScheduledCodexAppRecoveryPrompt,
} from "./scheduled-app-authority.js";
import { canResolveScheduledConfiguredMcpCreatorAuthority } from "./scheduled-configured-mcp-authority.js";
import {
  createIsolatedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { fingerprintJsonObject } from "./thread-fingerprints.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-lifecycle.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

function resolveCodexAttemptBundleManifestRegistry(
  preparedModelRuntime: EmbeddedRunAttemptParams["preparedModelRuntime"],
) {
  const metadataSnapshot = preparedModelRuntime?.metadataSnapshot;
  // Scoped snapshots are partial views and cannot replace complete bundle discovery.
  return metadataSnapshot?.pluginIds === undefined ? metadataSnapshot?.manifestRegistry : undefined;
}

export async function prepareCodexAttemptRuntime(connection: CodexAttemptConnection) {
  const {
    params,
    pluginConfig,
    usesSupervisionConnection,
    appServer,
    startupAuthProfileId,
    startupPreparedAuth,
    startupClientAuthProfileId,
    agentDir,
    preDynamicStartupStages,
    effectiveWorkspace,
    contextSessionKey,
    sandboxSessionKey,
    sessionAgentId,
    policyAgentId,
    sandbox,
    attemptClientFactory,
    runAbortController,
    activeContextEngine,
    mutable,
  } = connection;
  const preparedAuthBinding =
    !usesSupervisionConnection && appServer.start.homeScope !== "user" && startupAuthProfileId
      ? await prepareCodexAppServerAuthBinding({
          authProfileId: startupAuthProfileId,
          authProfileStore: params.authProfileStore,
          agentDir,
          config: params.config,
        })
      : undefined;
  assertScheduledCodexAppAuthorityRuntime(connection, params);
  const attemptAuthProfileStore = preparedAuthBinding?.authProfileStore ?? params.authProfileStore;
  prewarmCodexAttemptClient({
    connection,
    authProfileStore: attemptAuthProfileStore,
    authBindingFingerprint: preparedAuthBinding?.fingerprint,
  });
  const effectiveContextWindowInfo = usesSupervisionConnection
    ? undefined
    : params.contextWindowInfo;
  const effectiveContextTokenBudget = usesSupervisionConnection
    ? undefined
    : params.contextTokenBudget;
  const effectiveRuntimeProviderId = usesSupervisionConnection
    ? (mutable.startupBinding?.modelProvider ?? "codex")
    : params.provider;
  const effectiveRuntimeModelId = usesSupervisionConnection
    ? (mutable.startupBinding?.model ?? "codex-native")
    : (connection.options.runtimeModelId ?? params.modelId);
  const {
    authProfileId: _outerAuthProfileId,
    authoredContextTokenCap: _outerAuthoredContextTokenCap,
    contextWindowInfo: _outerContextWindowInfo,
    contextTokenBudget: _outerContextTokenBudget,
    model: _outerModel,
    modelId: _outerModelId,
    provider: _outerProvider,
    runtimePlan: _outerRuntimePlan,
    requestedModelId: _outerRequestedModelId,
    fallbackReason: _outerFallbackReason,
    degradedReason: _outerDegradedReason,
    thinkLevel: _outerThinkLevel,
    fastMode: _outerFastMode,
    ...paramsWithoutOuterNativeOwnership
  } = params;
  const supervisedRuntimeModel = {
    id: effectiveRuntimeModelId,
    name: effectiveRuntimeModelId,
    provider: effectiveRuntimeProviderId,
    api: "openai-chatgpt-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: undefined,
    maxTokens: undefined,
  } as unknown as EmbeddedRunAttemptParams["model"];
  const legacyScheduledAppRecoveryPrompt = buildLegacyScheduledCodexAppRecoveryPrompt(params);
  const runtimeParams: EmbeddedRunAttemptParams = usesSupervisionConnection
    ? {
        ...paramsWithoutOuterNativeOwnership,
        provider: "codex",
        modelId: effectiveRuntimeModelId,
        model: supervisedRuntimeModel,
        thinkLevel: _outerThinkLevel,
        fastMode: _outerFastMode,
        sessionKey: contextSessionKey,
      }
    : {
        ...params,
        authProfileStore: attemptAuthProfileStore,
        sessionKey: contextSessionKey,
        ...(legacyScheduledAppRecoveryPrompt
          ? {
              extraSystemPrompt: [params.extraSystemPrompt, legacyScheduledAppRecoveryPrompt]
                .filter((value): value is string => Boolean(value?.trim()))
                .join("\n\n"),
            }
          : {}),
        ...(startupAuthProfileId ? { authProfileId: startupAuthProfileId } : {}),
      };
  const activeSessionId = params.sessionId;
  const activeSessionFile = params.sessionFile;
  const buildActiveRunAttemptParams = (): EmbeddedRunAttemptParams => ({
    ...runtimeParams,
    sessionId: activeSessionId,
    sessionFile: activeSessionFile,
  });
  const startupAuthAccountCacheKey = usesSupervisionConnection
    ? undefined
    : startupPreparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(startupPreparedAuth.apiKey)
      : startupPreparedAuth?.kind === "profile"
        ? startupPreparedAuth.snapshot?.secretFreeCacheKey
        : await resolveCodexAppServerAuthAccountCacheKey({
            authProfileId: startupAuthProfileId,
            authProfileStore: attemptAuthProfileStore,
            agentDir,
            config: params.config,
          });
  const startupEnvApiKeyCacheKey = usesSupervisionConnection
    ? undefined
    : startupPreparedAuth || startupAuthProfileId
      ? undefined
      : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: appServer.start });
  preDynamicStartupStages.mark("auth-cache");
  const codexMcpToolOverrides = resolveCodexMcpToolOverridesForAgent(params.config, {
    agentId: sessionAgentId,
    toolOverrides: params.toolOverrides,
  });
  const bundleManifestRegistry = resolveCodexAttemptBundleManifestRegistry(
    params.preparedModelRuntime,
  );
  const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
    workspaceDir: effectiveWorkspace,
    agentId: sessionAgentId,
    cfg: params.config,
    toolsEnabled: usesSupervisionConnection || supportsModelTools(params.model),
    disableTools: params.disableTools,
    toolsAllow: params.toolsAllow,
    manifestRegistry: bundleManifestRegistry,
    toolOverrides: codexMcpToolOverrides,
  });
  const authenticatedScheduledMode =
    params.trigger === "cron" &&
    params.scheduledToolPolicy !== undefined &&
    Array.isArray(params.toolsAllow);
  const scheduledConfiguredMcpSurface =
    authenticatedScheduledMode &&
    (bundleMcpThreadConfig.staticServerNames.length > 0 ||
      mutable.startupBinding?.configuredMcpOwnershipVersion === 1);
  const cronCreatorAuthorityCapability = params.cronCreatorAuthorityCapability;
  // Senderless local operator RPCs prove freshness with the host-minted exact-run
  // capability; do not promote that fact to general sender ownership.
  const hasFreshCreatorAuthority =
    cronCreatorAuthorityCapability?.active === true &&
    !(
      cronCreatorAuthorityCapability.managementEntitlement &&
      cronCreatorAuthorityCapability.callerOrigin.kind === "unknown"
    ) &&
    cronCreatorAuthorityCapability.runId === params.runId &&
    !cronCreatorAuthorityCapability.signal.aborted;
  const mayResolveScheduledConfiguredMcpCreatorAuthority =
    !authenticatedScheduledMode &&
    canResolveScheduledConfiguredMcpCreatorAuthority({
      trigger: params.trigger,
      connectionClass: appServer.connectionClass,
      bindingKind: connection.bindingIdentity.kind,
      bindingSessionKey:
        connection.bindingIdentity.kind === "session"
          ? connection.bindingIdentity.sessionKey
          : undefined,
      sessionKey: params.sessionKey,
      usesSupervisionConnection,
      preservesNativeModel: mutable.startupBinding?.preserveNativeModel === true,
      senderIsOwner: params.senderIsOwner,
      hasFreshCreatorAuthority,
      senderId: params.senderId,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      spawnedBy: params.spawnedBy,
      scheduledToolPolicy: params.scheduledToolPolicy,
      hasStaticConfiguredMcp: bundleMcpThreadConfig.staticServerNames.length > 0,
    });
  preDynamicStartupStages.mark("bundle-mcp");
  const sandboxExecServerEnabled = isCodexSandboxExecServerEnabled(pluginConfig, sandbox);
  let nativeToolSurfaceEnabled = shouldEnableCodexAppServerNativeToolSurface(
    runtimeParams,
    sandbox,
    { agentId: policyAgentId, runtimeSessionKey: sandboxSessionKey, sandboxExecServerEnabled },
  );
  if (
    nativeToolSurfaceEnabled &&
    sandbox?.enabled &&
    sandbox.backend &&
    params.hostCapabilities.retainSourceAuthority
  ) {
    const client = await attemptClientFactory({
      assertCurrent: connection.assertCurrent,
      startOptions: appServer.start,
      pluginConfig,
      ...(startupPreparedAuth
        ? { preparedAuth: startupPreparedAuth }
        : { authProfileId: startupClientAuthProfileId }),
      authRequirement: connection.startupAuthRequirement,
      authProfileStore: attemptAuthProfileStore,
      authBindingFingerprint: preparedAuthBinding?.fingerprint,
      ...(connection.runtimeArtifactRequest
        ? {
            runtimeArtifactMode: "capture" as const,
            ...(connection.runtimeArtifactRequest.expected
              ? { expectedRuntimeArtifact: connection.runtimeArtifactRequest.expected }
              : {}),
          }
        : {}),
      agentId: sessionAgentId,
      agentDir,
      config: params.config,
      abandonSignal: runAbortController.signal,
      timeoutMs: appServer.requestTimeoutMs,
    });
    try {
      connection.assertCurrent();
      await assertCodexNativeHookRelayAllowed(
        client,
        runAbortController.signal,
        appServer.requestTimeoutMs,
      );
      connection.assertCurrent();
    } catch (error) {
      if (!(error instanceof CodexManagedHooksOnlyError)) {
        throw error;
      }
      connection.assertCurrent();
      // Choose the existing sandbox-backed tools before their catalog and prompt are built.
      nativeToolSurfaceEnabled = false;
      embeddedAgentLog.info("Codex managed-only hooks require sandbox-backed OpenClaw tools");
    } finally {
      if (attemptClientFactory === createIsolatedCodexAppServerClient) {
        await client.closeAndWait();
      } else {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    }
  }
  const configuredMcpSurface = scheduledConfiguredMcpSurface
    ? "scheduled"
    : !nativeToolSurfaceEnabled && bundleMcpThreadConfig.staticServerNames.length > 0
      ? "transient"
      : undefined;
  preDynamicStartupStages.mark("native-tool-surface");
  const webSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled,
  });
  const supervisedSearchFingerprint =
    usesSupervisionConnection && !mutable.startupBinding?.pendingSupervisionBranch
      ? mutable.startupBinding?.webSearchThreadConfigFingerprint
      : undefined;
  let nativeProviderWebSearchSupport: CodexNativeWebSearchSupport;
  // The bound thread owns its established search policy, not the daemon's current
  // provider defaults. Explicit OpenClaw policy changes still pass the lifecycle checks.
  if (isCodexResponsesOAuth(startupPreparedAuth)) {
    nativeProviderWebSearchSupport = "supported";
  } else if (
    webSearchPlan.kind !== "native-hosted" ||
    supervisedSearchFingerprint ===
      fingerprintJsonObject(resolveCodexWebSearchPlan({ disableTools: true }).threadConfig)
  ) {
    nativeProviderWebSearchSupport = "unsupported";
  } else if (supervisedSearchFingerprint === fingerprintJsonObject(webSearchPlan.threadConfig)) {
    nativeProviderWebSearchSupport = "supported";
  } else {
    nativeProviderWebSearchSupport = await resolveCodexProviderWebSearchSupport({
      clientFactory: attemptClientFactory,
      appServer,
      authProfileId: startupClientAuthProfileId,
      preparedAuth: startupPreparedAuth,
      agentDir,
      config: params.config,
      expectedNativeModelProvider: usesSupervisionConnection
        ? mutable.startupBinding?.modelProvider
        : undefined,
      modelProviderOverride: usesSupervisionConnection
        ? undefined
        : resolveCodexAppServerThreadModelSelection({
            homeScope: appServer.start.homeScope,
            provider: params.provider,
            model: params.modelId,
            binding: mutable.startupBinding,
            authProfileId: startupAuthProfileId,
            authProfileStore: attemptAuthProfileStore,
            agentDir,
            config: params.config,
          }).modelProvider,
      signal: runAbortController.signal,
    });
  }
  preDynamicStartupStages.mark("provider-capabilities");
  for (const diagnostic of bundleMcpThreadConfig.diagnostics) {
    embeddedAgentLog.warn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  if (activeContextEngine) {
    assertContextEngineHostSupport({
      contextEngine: activeContextEngine,
      operation: "agent-run",
      host: CODEX_APP_SERVER_CONTEXT_ENGINE_HOST,
    });
  }
  const hookChannelId = resolveCodexAppServerHookChannelId(params, sandboxSessionKey);
  preDynamicStartupStages.mark("context-engine-support");
  return {
    connection,
    preparedAuthBinding,
    runtimeParams,
    activeSessionId,
    activeSessionFile,
    buildActiveRunAttemptParams,
    attemptAuthProfileStore,
    effectiveContextWindowInfo,
    effectiveContextTokenBudget,
    effectiveRuntimeProviderId,
    effectiveRuntimeModelId,
    startupAuthAccountCacheKey,
    startupEnvApiKeyCacheKey,
    bundleMcpThreadConfig,
    bundleManifestRegistry,
    authenticatedScheduledMode,
    configuredMcpSurface,
    canResolveScheduledConfiguredMcpCreatorAuthority:
      mayResolveScheduledConfiguredMcpCreatorAuthority,
    codexMcpToolOverrides,
    sandboxExecServerEnabled,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
  };
}

export type CodexAttemptRuntime = Awaited<ReturnType<typeof prepareCodexAttemptRuntime>>;
