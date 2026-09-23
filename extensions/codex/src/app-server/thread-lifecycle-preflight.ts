import {
  AgentHarnessPreflightError,
  embeddedAgentLog,
  formatErrorMessage,
  isHostScopedAgentToolActive,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import { buildCodexUserMcpServersThreadConfigPatchForRun } from "openclaw/plugin-sdk/codex-mcp-projection";
import { normalizeCodexAppServerBindingModelProvider } from "./auth-profile.js";
import { getCodexAppServerClientInstanceId } from "./client.js";
import {
  CODEX_SESSION_OVERRIDABLE_LAYER_TYPES,
  readCodexEffectiveConfig,
} from "./config-layer-policy.js";
import { assertCodexModelBackedReviewerEffectiveConfig } from "./config-reviewer.js";
import {
  isMessageOnlyCodexSourceReply,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
} from "./dynamic-tool-profile.js";
import {
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  getCodexInferenceThread,
  prepareCodexInferenceThreadConfig,
} from "./inference-routing.js";
import {
  assertCodexNativeHookRelayAllowed,
  CodexManagedHooksOnlyError,
} from "./native-hook-relay.js";
import { resolveCodexNativeModelInputTools } from "./native-model-input-tools.js";
import { resolveCodexNativeSkillIsolation } from "./native-skill-isolation.js";
import { isCodexAppServerProfilerEnabled } from "./profiler-flag.js";
import { mergeCodexNativeProjectDocThreadConfig } from "./project-doc-thread-config.js";
import { flattenCodexDynamicToolFunctions, isJsonObject } from "./protocol.js";
import { readScheduledCodexAppManagedRequirementsFingerprint } from "./scheduled-app-authority.js";
import {
  hashCodexAppServerBindingFingerprint,
  type CodexAppServerBindingIdentity,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { buildContextEngineBinding } from "./thread-context-engine.js";
import {
  codexLegacyDynamicToolsFingerprint as legacyFingerprintDynamicTools,
  fingerprintEnvironmentSelection,
  fingerprintJsonObject,
  fingerprintUserMcpServersConfigPatch,
  legacyFingerprintUserMcpServersConfigPatch,
} from "./thread-fingerprints.js";
import { createCodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type {
  CodexAppServerThreadLifecycleBinding,
  CodexStartOrResumeThreadParams,
  CodexThreadRequestContext,
} from "./thread-lifecycle-types.js";
import { resolveCodexAppServerThreadModelSelection } from "./thread-model-selection.js";
import {
  assertCodexManagedRequirementsDoNotOverrideToolPolicy,
  buildCodexRingZeroThreadConfigPatch,
  CODEX_RING_ZERO_BASE_INSTRUCTIONS,
  readCodexInheritedMcpServerNames,
} from "./thread-requests.js";
import { resolveCodexWebSearchPlan } from "./web-search.js";

function assertCodexThreadInferenceAuthority(
  params: CodexStartOrResumeThreadParams,
  modelPolicyEnforced: boolean,
): void {
  if (params.inferenceRoute && modelPolicyEnforced) {
    return;
  }
  const host = params.params.hostCapabilities;
  const unavailable = () =>
    new AgentHarnessPreflightError(
      "This Codex connection cannot enforce your operator role's model policy. Use an OpenClaw-managed connection with an owned inference route; no turn was sent.",
    );
  if (!host.retainSourceAuthority) {
    throw unavailable();
  }
  const source = host.retainSourceAuthority();
  if (source === undefined) {
    return;
  }
  try {
    source.assertCurrent();
    if (source.modelPolicyRequired !== false) {
      throw unavailable();
    }
  } finally {
    source.release();
  }
}

/** Preserve the selected provider when only its physical thread must be replaced. */
export async function prepareCodexThreadRequestContext(
  params: CodexStartOrResumeThreadParams,
  options: {
    binding: CodexAppServerThreadBinding | undefined;
    selectionBinding: CodexAppServerThreadBinding | undefined;
    bindingIdentity: CodexAppServerBindingIdentity;
    clientId: string;
    config: CodexStartOrResumeThreadParams["config"];
    preflight: Awaited<ReturnType<typeof prepareCodexThreadLifecyclePreflight>>;
    assertCurrent: () => void;
    throwIfAborted: () => void;
  },
): Promise<CodexThreadRequestContext> {
  const startModelSelection = resolveCodexAppServerThreadModelSelection({
    provider: params.params.provider,
    model: params.runtimeModelId ?? params.params.modelId,
    binding: options.selectionBinding,
    authProfileId: params.params.authProfileId,
    authProfileStore: params.params.authProfileStore,
    agentDir: params.params.agentDir,
    config: params.params.config,
  });
  const source = params.params.hostCapabilities.retainSourceAuthority?.();
  const modelPolicyEnforced =
    params.nativeModelAdmission === undefined ||
    options.preflight.nativeModelInputTools !== undefined;
  let inference: Awaited<ReturnType<typeof prepareCodexInferenceThreadConfig>>;
  try {
    source?.assertCurrent();
    inference = await prepareCodexInferenceThreadConfig({
      ...params,
      config: options.config,
      binding: options.binding,
      clientId: options.clientId,
      operatorBacked: source !== undefined,
      modelPolicyEnforced,
      modelProvider:
        options.binding?.preserveNativeModel || options.binding?.connectionScope === "supervision"
          ? options.binding.modelProvider
          : startModelSelection.modelProvider,
      effectiveConfig: options.preflight.effectiveConfig,
      assertCurrent: () => {
        options.assertCurrent();
        source?.assertCurrent();
      },
    });
  } finally {
    source?.release();
  }
  // Each retry starts from caller configuration, never a previously injected private URL.
  params.config = inference?.config ?? options.config;
  params.inferenceRoute = inference?.route;
  params.inferenceProviderRoutes = inference?.providers;
  params.assertCurrent = () => {
    options.throwIfAborted();
    options.assertCurrent();
    assertCodexThreadInferenceAuthority(params, modelPolicyEnforced);
  };
  params.assertCurrent();
  return {
    ...options.preflight,
    bindingIdentity: options.bindingIdentity,
    startModelSelection,
    startModelProvider: startModelSelection.modelProvider,
    normalizeBindingModelProvider: (authProfileId, modelProvider) =>
      normalizeCodexAppServerBindingModelProvider({
        authProfileId,
        modelProvider,
        authProfileStore: params.params.authProfileStore,
        agentDir: params.params.agentDir,
        config: params.params.config,
      }),
    throwIfAborted: options.throwIfAborted,
  };
}

export function publishCodexThreadInferenceBinding(
  params: CodexStartOrResumeThreadParams,
  binding: CodexAppServerThreadLifecycleBinding,
  reusedConfiguration = false,
): CodexAppServerThreadLifecycleBinding {
  params.assertCurrent?.();
  params.signal?.throwIfAborted();
  assertCodexInferenceRouteConfig(
    params.client,
    params.inferenceRoute,
    params.config,
    binding.modelProvider,
    params.inferenceProviderRoutes,
  );
  if (reusedConfiguration) {
    if (getCodexInferenceThread(params.client, binding.threadId) !== params.inferenceRoute) {
      throw new Error("Codex inference thread configuration changed before reuse");
    }
  } else {
    bindCodexInferenceThread(
      params.client,
      binding.threadId,
      params.inferenceRoute,
      params.inferenceProviderRoutes,
    );
  }
  return binding;
}

export function resolveCodexThreadAgentDir(params: CodexStartOrResumeThreadParams): string {
  const agentId = resolveSessionAgentIdsStrict({
    config: params.params.config,
    sessionKey: params.params.sessionKey,
    agentId: params.agentId ?? params.params.agentId,
  }).sessionAgentId;
  return (
    params.agentDir ??
    params.params.agentDir ??
    resolveAgentDir(params.params.config ?? {}, agentId)
  );
}

export async function prepareCodexThreadLifecyclePreflight(params: CodexStartOrResumeThreadParams) {
  let effectiveConfig = await assertCodexModelBackedReviewerEffectiveConfig({
    client: params.client,
    approvalsReviewer: params.appServer.approvalsReviewer,
    cwd: params.cwd,
    signal: params.signal,
  });
  const nativeHooksRequired =
    params.nativeHookRelayRequired || params.nativeModelAdmission === "required";
  let modelAdmissionAvailable =
    params.nativeModelAdmission !== undefined &&
    (params.nativeModelAdmission !== "disabled" || nativeHooksRequired);
  if (nativeHooksRequired || modelAdmissionAvailable) {
    try {
      await assertCodexNativeHookRelayAllowed(params.client, params.signal);
    } catch (error) {
      if (nativeHooksRequired || !(error instanceof CodexManagedHooksOnlyError)) {
        throw error;
      }
      modelAdmissionAvailable = false;
    }
  }
  // Slow resumes must be diagnosable without enabling a profiler beforehand.
  const lifecycleTiming = createCodexThreadLifecycleTimingTracker({
    ...params.timing,
    enabled: params.timing?.enabled ?? isCodexAppServerProfilerEnabled(params.params.config),
  });
  const legacyDynamicToolsFingerprint = lifecycleTiming.measureSync(
    "legacy-dynamic-tools-fingerprint",
    () => legacyFingerprintDynamicTools(params.dynamicTools),
  );
  const dynamicToolsFingerprint = lifecycleTiming.measureSync("dynamic-tools-fingerprint", () =>
    hashCodexAppServerBindingFingerprint(legacyDynamicToolsFingerprint),
  );
  const dynamicToolsContainDeferred = flattenCodexDynamicToolFunctions(params.dynamicTools).some(
    (tool) => tool.deferLoading === true,
  );
  const webSearchPlan = lifecycleTiming.measureSync("web-search-plan", () =>
    resolveCodexWebSearchPlan({
      config: params.params.config,
      disableTools: params.params.disableTools,
      nativeToolSurfaceEnabled: params.nativeCodeModeEnabled,
      nativeProviderWebSearchSupport: params.nativeProviderWebSearchSupport,
      webSearchAllowed: params.webSearchAllowed,
    }),
  );
  const webSearchThreadConfigFingerprint = fingerprintJsonObject(webSearchPlan.threadConfig);
  const networkProxyConfigFingerprint = params.appServer.networkProxy?.configFingerprint;
  const contextEngineBinding = lifecycleTiming.measureSync("context-engine-binding", () =>
    buildContextEngineBinding(params.params, params.contextEngineProjection),
  );
  const userMcpServersConfigPatch =
    params.userMcpServersEnabled === false
      ? undefined
      : await buildCodexUserMcpServersThreadConfigPatchForRun({
          run: params.params,
          cwd: params.cwd,
          agentId: params.agentId ?? params.params.agentId,
          allowLiteralOAuthProjection: params.appServer.connectionClass !== "remote",
          warn: (message) => embeddedAgentLog.warn(message),
          onServerUnavailable: (serverName, error) =>
            embeddedAgentLog.warn("skipping unavailable MCP OAuth server", {
              serverName,
              error: formatErrorMessage(error),
            }),
        });
  const nativeSkillIsolation = await lifecycleTiming.measure("native-skill-isolation", () =>
    resolveCodexNativeSkillIsolation({
      client: params.client,
      codexHome: params.appServer.start.codexHome ?? params.appServer.start.env?.CODEX_HOME,
      cwd: params.cwd,
      home: params.appServer.start.env?.HOME,
      signal: params.signal,
      userProfile: params.appServer.start.env?.USERPROFILE,
    }),
  );
  const nativeSkillIsolationFingerprint = nativeSkillIsolation
    ? fingerprintJsonObject({
        version: 1,
        disabledUserSkillPaths: nativeSkillIsolation.disabledUserSkillPaths,
      })
    : undefined;
  const legacyUserMcpServersFingerprint =
    legacyFingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const userMcpServersFingerprint = fingerprintUserMcpServersConfigPatch(userMcpServersConfigPatch);
  const environmentSelectionFingerprint = fingerprintEnvironmentSelection(
    params.environmentSelection,
  );
  const hostSystemAgentActive =
    params.hostSystemAgentActive ?? isHostScopedAgentToolActive("openclaw");
  const ringZeroActive =
    hostSystemAgentActive && isSystemAgentOnlyCodexDynamicToolAllowlist(params.params.toolsAllow);
  const messageOnlySourceReply = isMessageOnlyCodexSourceReply(params.params);
  const restrictedToolSurface =
    ringZeroActive ||
    messageOnlySourceReply ||
    params.params.pluginHarnessToolPolicyRestricted === true;
  const allowConfiguredManagedHooks =
    params.params.pluginHarnessToolPolicyRestricted === true &&
    !ringZeroActive &&
    !messageOnlySourceReply &&
    params.params.scheduledRuntimeAuthority === undefined;
  const imageGenerationDenied =
    params.params.pluginHarnessToolPolicySafeDeniedTools?.includes("image_generate") === true;
  if (restrictedToolSurface && params.nativeCodeModeEnabled !== false) {
    throw new Error("Codex restricted tool surfaces require native code mode to be disabled");
  }
  if (!effectiveConfig) {
    effectiveConfig = await lifecycleTiming.measure("effective-config-read", () =>
      readCodexEffectiveConfig(params.client, params.cwd, { signal: params.signal }),
    );
  }
  params.config = mergeCodexNativeProjectDocThreadConfig(params.config, effectiveConfig);
  const restrictedToolSurfaceInheritedMcpServerNames = restrictedToolSurface
    ? await lifecycleTiming.measure("restricted-tool-surface-mcp-policy", () =>
        readCodexInheritedMcpServerNames(params.client, params.cwd, params.signal, effectiveConfig),
      )
    : [];
  if (restrictedToolSurface || imageGenerationDenied || params.nativeCodeModeEnabled !== false) {
    await lifecycleTiming.measure("tool-policy-config-requirements-read", () =>
      assertCodexManagedRequirementsDoNotOverrideToolPolicy(
        params.client,
        {
          restrictedToolSurface,
          requiredNativeShell: params.nativeCodeModeEnabled !== false,
          additionalDeniedFeatures: imageGenerationDenied ? ["image_generation"] : undefined,
          allowedManagedRequirementsFingerprint:
            readScheduledCodexAppManagedRequirementsFingerprint(
              params.params.scheduledRuntimeAuthority,
            ),
          // Plugin policy restricts model-visible tools, while configured hooks are
          // administrator policy. Stricter and detached surfaces remain fail closed.
          allowConfiguredManagedHooks,
        },
        params.signal,
      ),
    );
  }
  const features = effectiveConfig?.config.features;
  // Legacy managed layers outrank session flags without appearing in requirements.
  // Their effective shell denial must fence native capture before thread startup.
  if (
    params.nativeCodeModeEnabled !== false &&
    isJsonObject(features) &&
    features.shell_tool === false &&
    !CODEX_SESSION_OVERRIDABLE_LAYER_TYPES.has(
      effectiveConfig?.origins?.["features.shell_tool"]?.name.type ?? "",
    )
  ) {
    throw new Error(
      "Codex native code mode requires shell_tool, but the effective shell setting cannot be overridden. Ask your administrator to allow the shell, or select a tool policy that disables native code mode; no automation authority was captured.",
    );
  }
  const ringZeroConfigFingerprint = ringZeroActive
    ? fingerprintJsonObject({
        version: 1,
        baseInstructions: CODEX_RING_ZERO_BASE_INSTRUCTIONS,
        config: buildCodexRingZeroThreadConfigPatch(
          params.params,
          true,
          restrictedToolSurfaceInheritedMcpServerNames,
        )!,
      })
    : undefined;
  const ringZeroClientInstanceId = ringZeroActive
    ? getCodexAppServerClientInstanceId(params.client)
    : undefined;
  return {
    nativeModelInputTools:
      nativeHooksRequired || modelAdmissionAvailable
        ? resolveCodexNativeModelInputTools(effectiveConfig.config)
        : undefined,
    effectiveConfig,
    contextEngineBinding,
    dynamicToolsContainDeferred,
    dynamicToolsFingerprint,
    environmentSelectionFingerprint,
    hostSystemAgentActive,
    legacyDynamicToolsFingerprint,
    legacyUserMcpServersFingerprint,
    lifecycleTiming,
    nativeSkillIsolation,
    nativeSkillIsolationFingerprint,
    networkProxyConfigFingerprint,
    ringZeroActive,
    ringZeroClientInstanceId,
    ringZeroConfigFingerprint,
    restrictedToolSurface,
    restrictedToolSurfaceInheritedMcpServerNames,
    userMcpServersConfigPatch,
    userMcpServersFingerprint,
    webSearchThreadConfigFingerprint,
  };
}
