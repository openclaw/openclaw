import {
  applyEmbeddedAttemptToolsAllow,
  buildAgentHookContextChannelFields,
  buildEmbeddedAttemptToolRunContext,
  embeddedAgentLog,
  filterProviderNormalizableTools,
  getPluginToolMeta,
  isHostScopedAgentToolActive,
  isSubagentSessionKey,
  normalizeAgentRuntimeTools,
  resolveAttemptSpawnWorkspaceDir,
  resolveModelAuthMode,
  resolveSandboxContext,
  supportsModelTools,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type RuntimeToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { resolveCodexScheduledToolProjectionFactory } from "openclaw/plugin-sdk/codex-mcp-projection";
import { isToolAllowed } from "openclaw/plugin-sdk/sandbox";
import {
  createStageTimingTracker,
  formatStageTimings,
  type StageTimingSummary,
} from "openclaw/plugin-sdk/time-runtime";
import { CODEX_NATIVE_TOOL_REQUIREMENTS } from "../../native-tool-policy.js";
import type { CodexComputerContextEpoch } from "./computer-context.js";
import {
  isCodexRemoteExecPlacementSandbox,
  readCodexPluginConfig,
  type CodexPluginConfig,
} from "./config.js";
import {
  createCodexHostToolSurface,
  resolveCodexToolConstructionPlan,
} from "./dynamic-tool-construction-plan.js";
import {
  filterCodexDynamicTools,
  isForcedPrivateQaCodexRuntime,
  isSystemAgentOnlyCodexDynamicToolAllowlist,
  normalizeCodexDynamicToolName,
} from "./dynamic-tool-profile.js";
import {
  resolveCodexNodeExecToolOverrides,
  prepareCodexNativeExecutionPolicyForRun,
  resolveCodexNativeExecutionPolicyForRun,
  type CodexNativeExecutionPolicy,
  type PreparedCodexNativeExecutionPolicy,
} from "./native-execution-policy.js";
import type { CodexSandboxPolicy, CodexTurnEnvironmentParams } from "./protocol.js";
import { mapCodexAppServerRemoteWorkspacePath } from "./remote-workspace-path.js";
import { isCodexResponsesOAuthRun } from "./responses-oauth.js";
import type { CodexSandboxExecEnvironment } from "./sandbox-exec-server.js";
import type { CodexEffectiveSessionPermissionPolicy } from "./session-permission-policy.js";
import {
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
  createGatewayExecProjection,
  createGatewayProcessProjection,
  createNodeExecAliasDynamicTool,
  createSandboxShellProjection,
  isCodexDynamicToolExcluded,
  placeDisabledNativeShellToolsInDirectNamespace,
  type NodeExecAvailabilityRef,
} from "./shell-dynamic-tools.js";
import { filterCodexVisionTools } from "./vision-tools.js";
import { resolveCodexWebSearchPlan, type CodexNativeWebSearchSupport } from "./web-search.js";

type OpenClawCodingToolsOptions = NonNullable<
  Parameters<
    (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingToolsAsync"]
  >[0]
>;

/** Factory seam for constructing OpenClaw runtime tools without eagerly loading agent-harness. */
type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingToolsAsync"];
type OpenClawDynamicTool = Awaited<ReturnType<OpenClawCodingToolsFactory>>[number];
type OpenClawSandboxContext = Awaited<ReturnType<typeof resolveSandboxContext>>;
type CodexDynamicToolBuildEvent = Parameters<
  NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>
>[0];
const CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW = new Set(["read", "write"]);

type DynamicToolBuildParams = {
  params: EmbeddedRunAttemptParams;
  resolvedWorkspace: string;
  effectiveWorkspace: string;
  effectiveCwd?: string;
  sandboxSessionKey: string;
  sandbox: OpenClawSandboxContext;
  sessionPermissionPolicy?: CodexEffectiveSessionPermissionPolicy;
  nativeToolSurfaceEnabled?: boolean;
  nativeExecutionPolicy?: PreparedCodexNativeExecutionPolicy;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  runAbortController: AbortController;
  nodeExecAvailability?: NodeExecAvailabilityRef;
  sessionAgentId: string;
  policyAgentId: string;
  pluginConfig: CodexPluginConfig;
  profilerEnabled?: boolean;
  cronCreatorToolAllowlistRef?: OpenClawCodingToolsOptions["cronCreatorToolAllowlistRef"];
  cronCreatorToolAllowlistCaptureRef?: OpenClawCodingToolsOptions["cronCreatorToolAllowlistCaptureRef"];
  resolveCronCreatorToolAuthority?: Parameters<typeof createCodexHostToolSurface>[3];
  cronCreatorAuthorityUnavailableReason?: OpenClawCodingToolsOptions["cronCreatorAuthorityUnavailableReason"];
  ignoreDisableMessageTool?: boolean;
  ignoreRuntimePlan?: boolean;
  /** Host fact resolver; injectable only for focused plugin contract tests. */
  isHostScopedToolActive?: (toolName: string) => boolean;
  onYieldDetected: (message: string, acknowledgment?: string) => void;
  claimYieldCompletion?: OpenClawCodingToolsOptions["claimYieldCompletion"];
  onCodexAppServerEvent?: (event: CodexDynamicToolBuildEvent) => void;
  onPersistentWebSearchPolicyResolved?: (allowed: boolean) => void;
  onWebSearchPolicyResolved?: (allowed: boolean) => void;
  onMessageToolTargetResolved?: (requireExplicitMessageTarget: boolean) => void;
  computerContextEpoch?: CodexComputerContextEpoch;
  registerRunCleanup?: OpenClawCodingToolsOptions["registerRunCleanup"];
};
export function resolveCodexMessageToolProvider(
  params: Pick<EmbeddedRunAttemptParams, "messageChannel" | "messageProvider">,
): string | undefined {
  return params.messageChannel ?? params.messageProvider;
}
export function resolveCodexAppServerHookChannelId(
  params: EmbeddedRunAttemptParams,
  sandboxSessionKey: string,
): string | undefined {
  return buildAgentHookContextChannelFields({
    sessionKey: sandboxSessionKey,
    messageChannel: params.messageChannel,
    messageProvider: params.messageProvider,
    currentChannelId: params.currentChannelId,
    messageTo: params.messageTo,
  }).channelId;
}
const CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS = 1_000;
const CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS = 500;
export function shouldWarnCodexDynamicToolBuildStageSummary(
  summary: StageTimingSummary,
  profilerEnabled = false,
): boolean {
  const totalWarnMs = profilerEnabled ? CODEX_DYNAMIC_TOOL_BUILD_WARN_TOTAL_MS : 10_000;
  const stageWarnMs = profilerEnabled ? CODEX_DYNAMIC_TOOL_BUILD_WARN_STAGE_MS : 5_000;
  return (
    summary.totalMs >= totalWarnMs ||
    summary.stages.some((stage) => stage.durationMs >= stageWarnMs)
  );
}
export async function buildDynamicTools(
  input: DynamicToolBuildParams,
): Promise<OpenClawDynamicTool[]> {
  const { params } = input;
  const messagePolicyParams = input.ignoreDisableMessageTool
    ? { ...params, disableMessageTool: false }
    : params;
  const toolRunContext = buildEmbeddedAttemptToolRunContext({
    ...params,
    forceMessageTool: shouldForceMessageTool(messagePolicyParams),
  });
  if (params.disableTools) {
    input.onWebSearchPolicyResolved?.(false);
    return [];
  }
  if (!supportsModelTools(params.model)) {
    input.onPersistentWebSearchPolicyResolved?.(false);
    input.onWebSearchPolicyResolved?.(false);
    return [];
  }
  const toolBuildStages = createStageTimingTracker();
  const modelHasVision = params.model.input?.includes("image") ?? false;
  const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, input.sessionAgentId);
  const preparedExecution =
    input.nativeExecutionPolicy ??
    (await prepareCodexNativeExecutionPolicyForRun(params, {
      agentId: input.policyAgentId,
      runtimeSessionKey: input.sandboxSessionKey,
      sandbox: input.sandbox,
    }));
  preparedExecution.assertCurrent();
  const nativeExecutionPolicy = preparedExecution.policy;
  const webSearchPlan = resolveCodexWebSearchPlan({
    config: params.config,
    disableTools: params.disableTools,
    nativeToolSurfaceEnabled: isCodexResponsesOAuthRun(params) || input.nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
  });
  const messageToolProvider = resolveCodexMessageToolProvider(params);
  const webFetchHostnameAllowlistRef: { value?: string[] } = {};
  const toolConstructionPlan = resolveCodexToolConstructionPlan(
    input.sandbox,
    input.nativeToolSurfaceEnabled,
    params.requireWorkspaceOnly,
  );
  const options: OpenClawCodingToolsOptions = {
    agentId: input.sessionAgentId,
    policyAgentId: input.policyAgentId,
    ...toolRunContext,
    exec: {
      ...params.execOverrides,
      ...(input.sessionPermissionPolicy ? { mode: input.sessionPermissionPolicy.execMode } : {}),
      ...resolveCodexNodeExecToolOverrides(nativeExecutionPolicy),
      config: params.config,
      elevated: params.bashElevated,
    },
    sessionPermissionPolicy: input.sessionPermissionPolicy
      ? { mode: input.sessionPermissionPolicy.mode, root: input.sessionPermissionPolicy.root }
      : undefined,
    sandbox: input.sandbox,
    requireWorkspaceOnly: params.requireWorkspaceOnly,
    ...(toolConstructionPlan ? { toolConstructionPlan } : {}),
    messageProvider: messageToolProvider,
    toolPolicyMessageProvider: params.messageProvider ?? params.messageChannel,
    // Codex dispatches dynamic tools itself, so no tool-start handler reserves a
    // blocking question's prompt. Hand the tools this run's own way to show one.
    ...(params.onToolResult
      ? {
          questionPrompt: { send: params.onToolResult, messageChannel: messageToolProvider },
        }
      : {}),
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    allowGatewaySubagentBinding:
      params.allowGatewaySubagentBinding || isForcedPrivateQaCodexRuntime(),
    sessionKey: input.sandboxSessionKey,
    runSessionKey:
      params.sessionKey && params.sessionKey !== input.sandboxSessionKey
        ? params.sessionKey
        : undefined,
    sessionId: params.sessionId,
    runId: params.runId,
    memoryAudience: params.memoryAudience,
    agentDir,
    preparedModelRuntime: params.preparedModelRuntime,
    cwd: input.effectiveCwd ?? input.effectiveWorkspace,
    workspaceDir: input.effectiveWorkspace,
    spawnWorkspaceDir:
      input.effectiveCwd && input.effectiveCwd !== input.effectiveWorkspace
        ? input.resolvedWorkspace
        : resolveAttemptSpawnWorkspaceDir({
            sandbox: input.sandbox,
            resolvedWorkspace: input.resolvedWorkspace,
          }),
    config: params.config,
    skillsSnapshot: params.skillsSnapshot,
    ...(params.skillLibraryAuthoring
      ? { skillWorkshop: { libraryAuthoring: params.skillLibraryAuthoring } }
      : {}),
    authProfileStore: params.toolAuthProfileStore ?? params.authProfileStore,
    abortSignal: input.runAbortController.signal,
    emitBeforeToolCallDiagnostics: false,
    modelProvider: params.model.provider,
    modelId: params.modelId,
    modelCompat:
      params.model.compat && typeof params.model.compat === "object"
        ? (params.model.compat as OpenClawCodingToolsOptions["modelCompat"])
        : undefined,
    modelApi: params.model.api,
    modelContextWindowTokens: params.model.contextWindow,
    delegationCapability: params.delegationCapability,
    modelAuthMode: resolveModelAuthMode(
      params.model.provider,
      params.config,
      params.toolAuthProfileStore ?? params.authProfileStore,
      {
        workspaceDir: input.effectiveWorkspace,
      },
    ),
    suppressManagedWebSearch: false,
    webFetchHostnameAllowlistRef,
    hookChannelId: resolveCodexAppServerHookChannelId(params, input.sandboxSessionKey),
    modelHasVision,
    computerContextEpoch: input.computerContextEpoch,
    oneShotCliRun: params.oneShotCliRun,
    registerRunCleanup: input.registerRunCleanup,
    requireExplicitMessageTarget:
      params.requireExplicitMessageTarget ?? isSubagentSessionKey(params.sessionKey),
    disableMessageTool: input.ignoreDisableMessageTool ? false : params.disableMessageTool,
    forceMessageTool: shouldForceMessageTool(messagePolicyParams),
    onYield: (message, acknowledgment) => {
      input.onYieldDetected(message, acknowledgment);
      input.onCodexAppServerEvent?.({
        stream: "codex_app_server.tool",
        data: { name: "sessions_yield", message },
      });
    },
    claimYieldCompletion: input.claimYieldCompletion,
    recordToolPrepStage: (name) => {
      toolBuildStages.mark(name);
    },
    onToolOutcome: params.onToolOutcome,
    isTurnTainted: params.isTurnTainted,
    allocateToolOutcomeOrdinal: params.allocateToolOutcomeOrdinal,
    cronCreatorToolAllowlistRef: input.cronCreatorToolAllowlistRef,
    cronCreatorToolAllowlistCaptureRef: input.cronCreatorToolAllowlistCaptureRef,
    cronCreatorAuthorityUnavailableReason: input.cronCreatorAuthorityUnavailableReason,
  };

  input.onMessageToolTargetResolved?.(options.requireExplicitMessageTarget === true);
  const allTools = await createCodexHostToolSurface(
    params,
    options,
    { cwd: input.effectiveCwd ?? input.effectiveWorkspace },
    input.resolveCronCreatorToolAuthority,
  );
  toolBuildStages.mark("create-openclaw-coding-tools");
  const preNormalizationDiagnostics: RuntimeToolSchemaDiagnostic[] = [];
  const readableAllToolProjection = filterProviderNormalizableTools(allTools);
  preNormalizationDiagnostics.push(...readableAllToolProjection.diagnostics);
  const readableAllTools = [...readableAllToolProjection.tools];
  const normallyProfiledTools = filterCodexDynamicTools(readableAllTools, input.pluginConfig, {
    disabledNativeSurface:
      input.nativeToolSurfaceEnabled === false
        ? {
            // Disabled Code Mode has no shell; retain the policy-filtered direct replacement.
            preserveShell:
              !isCodexMemoryFlushRun(params) &&
              input.sandbox?.enabled !== true &&
              nativeExecutionPolicy.effectiveExecHost !== "node",
          }
        : undefined,
  });
  const hostSystemAgentActive =
    input.isHostScopedToolActive?.("openclaw") ?? isHostScopedAgentToolActive("openclaw");
  const systemAgentTool =
    hostSystemAgentActive &&
    isSystemAgentOnlyCodexDynamicToolAllowlist(params.toolsAllow) &&
    readableAllTools.find((tool) => tool.name === "openclaw" && tool.catalogMode === "direct-only");
  const profileFilteredTools = systemAgentTool
    ? [systemAgentTool, ...normallyProfiledTools.filter((tool) => tool.name !== "openclaw")]
    : normallyProfiledTools;
  const codexFilteredTools = await addShellDynamicTools(
    isCodexMemoryFlushRun(params)
      ? readableAllTools.filter((tool) =>
          CODEX_MEMORY_FLUSH_DYNAMIC_TOOL_ALLOW.has(normalizeCodexDynamicToolName(tool.name)),
        )
      : profileFilteredTools,
    readableAllTools,
    input,
    nativeExecutionPolicy,
  );
  toolBuildStages.mark("codex-filtering");
  const visionFilteredTools = filterCodexVisionTools(codexFilteredTools, {
    modelHasVision,
    nativeImageInspectionEnabled: input.nativeToolSurfaceEnabled === true,
  });
  toolBuildStages.mark("vision-filtering");
  const webSearchPresent = visionFilteredTools.some((tool) => tool.name === "web_search");
  const persistentCodexWebSearchSurface =
    params.config?.tools?.web?.search?.enabled !== false &&
    !isCodexDynamicToolExcluded(input.pluginConfig, ["web_search"]);
  // A turn-scoped native restriction must not erase persistent hosted availability.
  // Permission still comes from the policy owner, independently of managed tools.
  const persistentHostedWebSearchEligible =
    resolveCodexWebSearchPlan({
      config: params.config,
      nativeProviderWebSearchSupport: input.nativeProviderWebSearchSupport,
    }).kind === "native-hosted";
  let nativeWebSearchAllowed = false;
  let persistentWebSearchAllowed = webSearchPresent;
  if (
    (input.onPersistentWebSearchPolicyResolved ||
      (webSearchPlan.kind === "native-hosted" &&
        (input.onWebSearchPolicyResolved || webSearchPlan.webFetchHostnameAllowlist))) &&
    !webSearchPresent &&
    persistentCodexWebSearchSurface
  ) {
    const webSearchPolicy = (
      await import("openclaw/plugin-sdk/agent-harness")
    ).resolveWebSearchToolPolicy({
      config: params.config,
      modelProvider: params.model.provider,
      modelId: params.modelId,
      agentId: input.policyAgentId,
      sessionKey: input.sandboxSessionKey,
      sessionId: params.sessionId,
      ...(persistentHostedWebSearchEligible
        ? { runtimeToolAllowlist: toolRunContext.runtimeToolAllowlist }
        : {}),
      sandboxToolPolicy: input.sandbox?.tools,
      messageProvider: messageToolProvider,
      agentAccountId: params.agentAccountId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      inputProvenance: params.inputProvenance,
      trustedInternalHandoff: params.trustedInternalHandoff,
      scheduledToolPolicy: params.scheduledToolPolicy,
    });
    persistentWebSearchAllowed =
      webSearchPolicy.persistentAllowed &&
      (persistentHostedWebSearchEligible ||
        !webSearchPolicy.allowed ||
        isCodexMemoryFlushRun(params));
    nativeWebSearchAllowed =
      webSearchPlan.kind === "native-hosted" &&
      webSearchPolicy.allowed &&
      !isCodexMemoryFlushRun(params);
  }
  input.onPersistentWebSearchPolicyResolved?.(persistentWebSearchAllowed);
  const filteredTools = applyEmbeddedAttemptToolsAllow(
    visionFilteredTools,
    toolRunContext.runtimeToolAllowlist,
    {
      toolMeta: getPluginToolMeta,
      toolAliases: (tool) => {
        const normalized = normalizeCodexDynamicToolName(tool.name);
        return normalized === "sandbox_exec" ||
          normalized === CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME ||
          normalized === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME
          ? ["exec"]
          : normalized === "sandbox_process" ||
              normalized === CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME
            ? ["exec", "process"]
            : [];
      },
    },
  );
  toolBuildStages.mark("allowlist-filter");
  const normalizedTools = normalizeAgentRuntimeTools({
    runtimePlan: input.ignoreRuntimePlan ? undefined : params.runtimePlan,
    tools: filteredTools,
    provider: params.provider,
    config: params.config,
    workspaceDir: input.effectiveWorkspace,
    env: process.env,
    modelId: params.modelId,
    modelApi: params.model.api,
    model: params.model,
    // Durable registration projects the prepared catalog; it must not activate
    // a different provider runtime while building the thread-stable schema.
    allowProviderRuntimePluginLoad: input.ignoreRuntimePlan ? false : undefined,
    onPreNormalizationSchemaDiagnostics: (diagnostics) =>
      preNormalizationDiagnostics.push(...diagnostics),
  });
  toolBuildStages.mark("runtime-normalization");
  // Resolve policy before hiding the managed tool. Hosted search follows the
  // same effective policy, while only one search implementation is exposed.
  const webSearchAllowed =
    nativeWebSearchAllowed || normalizedTools.some((tool) => tool.name === "web_search");
  webFetchHostnameAllowlistRef.value = webSearchAllowed
    ? webSearchPlan.webFetchHostnameAllowlist
    : undefined;
  input.onWebSearchPolicyResolved?.(webSearchAllowed);
  const webSearchFilteredTools = webSearchPlan.suppressManagedWebSearch
    ? normalizedTools.filter((tool) => tool.name !== "web_search")
    : normalizedTools;
  const exposedTools = placeDisabledNativeShellToolsInDirectNamespace(
    webSearchFilteredTools,
    input.nativeToolSurfaceEnabled,
  );
  if (preNormalizationDiagnostics.length > 0) {
    embeddedAgentLog.warn(
      `codex app-server quarantined ${preNormalizationDiagnostics.length} unsupported runtime tool schema${preNormalizationDiagnostics.length === 1 ? "" : "s"} before dynamic tool registration`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        diagnostics: preNormalizationDiagnostics.map((diagnostic) => ({
          index: diagnostic.toolIndex,
          tool: diagnostic.toolName,
          violations: diagnostic.violations.slice(0, 12),
          violationCount: diagnostic.violations.length,
        })),
      },
    );
  }
  const summary = toolBuildStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(summary, input.profilerEnabled)) {
    const phase = input.ignoreRuntimePlan ? "registered-tools" : "runtime-tools";
    embeddedAgentLog.warn(
      `codex app-server dynamic tool build timings runId=${params.runId} sessionId=${params.sessionId} phase=${phase} totalMs=${summary.totalMs} stages=${formatStageTimings(summary.stages)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        phase,
        totalMs: summary.totalMs,
        stages: summary.stages,
        allToolCount: readableAllTools.length,
        codexFilteredToolCount: codexFilteredTools.length,
        visionFilteredToolCount: visionFilteredTools.length,
        filteredToolCount: filteredTools.length,
        normalizedToolCount: exposedTools.length,
        ignoreRuntimePlan: input.ignoreRuntimePlan === true,
        nativeToolSurfaceEnabled: input.nativeToolSurfaceEnabled === true,
      },
    );
  }
  preparedExecution.assertCurrent();
  return exposedTools;
}
export function shouldEnableCodexAppServerNativeToolSurface(
  params: EmbeddedRunAttemptParams,
  sandbox?: OpenClawSandboxContext,
  options: {
    agentId?: string;
    runtimeSessionKey?: string;
    sandboxExecServerEnabled?: boolean;
    nativeExecutionPolicy?: PreparedCodexNativeExecutionPolicy;
  } = {},
): boolean {
  if (
    isCodexResponsesOAuthRun(params) ||
    params.requireWorkspaceOnly === true ||
    params.pluginHarnessToolPolicyRestricted === true ||
    isCodexMemoryFlushRun(params) ||
    params.disableTools
  ) {
    return false;
  }
  if (
    !(
      options.nativeExecutionPolicy?.policy ??
      resolveCodexNativeExecutionPolicyForRun(params, {
        agentId: options.agentId,
        runtimeSessionKey: options.runtimeSessionKey,
        sandbox,
      })
    ).nativeToolSurfaceAllowed
  ) {
    return false;
  }
  const toolsAllow = params.toolsAllow;
  // Codex native code mode exposes its shell/file surface as one app-server
  // capability, so narrow OpenClaw allowlists must fail closed rather than
  // widening `message` or `web_search` into shell access.
  return (
    (toolsAllow === undefined ||
      toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*")) &&
    canCodexAppServerNativeToolSurfaceHonorSandbox(sandbox, options)
  );
}
function canCodexAppServerNativeToolSurfaceHonorSandbox(
  sandbox: OpenClawSandboxContext | undefined,
  options: { sandboxExecServerEnabled?: boolean } = {},
): boolean {
  if (!sandbox?.enabled) {
    return true;
  }
  // Codex app-server native shell, filesystem, and user MCP execution are owned
  // by the app-server process. Without the explicit exec-server integration,
  // active OpenClaw sandboxing must disable the native surface and route shell
  // access through sandbox-backed dynamic tools instead.
  return (
    options.sandboxExecServerEnabled === true &&
    (sandbox.backend || isCodexRemoteExecPlacementSandbox(sandbox)) &&
    CODEX_NATIVE_TOOL_REQUIREMENTS.every((toolName) => isToolAllowed(sandbox.tools, toolName))
  );
}
function isCodexMemoryFlushRun(
  params?: Pick<EmbeddedRunAttemptParams, "trigger" | "memoryFlushWritePath">,
): boolean {
  return params?.trigger === "memory" && Boolean(params.memoryFlushWritePath?.trim());
}
/** Requires a Codex sandbox environment only when native tools must run inside OpenClaw sandboxing. */
export function shouldRequireCodexSandboxExecServerEnvironment(params: {
  sandbox?: OpenClawSandboxContext;
  nativeToolSurfaceEnabled: boolean;
  sandboxExecServerEnabled: boolean;
}): boolean {
  return Boolean(
    isCodexRemoteExecPlacementSandbox(params.sandbox) ||
    (params.sandbox?.enabled && params.nativeToolSurfaceEnabled && params.sandboxExecServerEnabled),
  );
}
export function resolveCodexSandboxEnvironmentSelection(
  environment: CodexSandboxExecEnvironment | undefined,
  nativeToolSurfaceEnabled: boolean,
): CodexTurnEnvironmentParams[] | undefined {
  // Omitting this selection while a turn sets cwd restores Codex's local
  // environment; an explicit empty selection keeps native tools disabled.
  return nativeToolSurfaceEnabled ? (environment ? [environment] : undefined) : [];
}
export function resolveCodexAppServerExecutionCwd(params: {
  effectiveCwd: string;
  localWorkspaceRoot: string;
  environment?: CodexSandboxExecEnvironment;
  nativeToolSurfaceEnabled: boolean;
  remoteWorkspaceRoot?: string;
}): string {
  const cwd =
    params.environment && params.nativeToolSurfaceEnabled
      ? params.environment.cwd
      : params.effectiveCwd;
  return mapCodexAppServerRemoteWorkspacePath({
    value: cwd,
    localWorkspaceRoot: params.localWorkspaceRoot,
    remoteWorkspaceRoot: params.remoteWorkspaceRoot,
  });
}
export function resolveCodexExternalSandboxPolicyForOpenClawSandbox(
  sandbox: OpenClawSandboxContext | undefined,
): CodexSandboxPolicy {
  const backendId = sandbox?.backendId.trim().toLowerCase();
  const dockerNetwork = backendId === "docker" || backendId === "podman";
  const network = dockerNetwork ? sandbox?.docker?.network?.trim().toLowerCase() : undefined;
  return {
    type: "externalSandbox",
    networkAccess: !dockerNetwork || (network && network !== "none") ? "enabled" : "restricted",
  };
}
export function disableCodexPluginThreadConfig(pluginConfig?: unknown): CodexPluginConfig {
  const config = readCodexPluginConfig(pluginConfig);
  return {
    ...config,
    codexPlugins: {
      ...config.codexPlugins,
      enabled: false,
    },
  };
}
/** Adds policy-selected shell aliases in sandbox, Gateway, then node order. */
async function addShellDynamicTools(
  filteredTools: OpenClawDynamicTool[],
  allTools: OpenClawDynamicTool[],
  input: DynamicToolBuildParams,
  executionPolicy: CodexNativeExecutionPolicy,
): Promise<OpenClawDynamicTool[]> {
  if (isCodexMemoryFlushRun(input.params)) {
    return filteredTools;
  }
  const execTool = allTools.find((tool) => normalizeCodexDynamicToolName(tool.name) === "exec");
  if (!execTool) {
    return filteredTools;
  }
  const processTool = allTools.find(
    (tool) => normalizeCodexDynamicToolName(tool.name) === "process",
  );
  const existingNames = new Set(
    filteredTools.map((tool) => normalizeCodexDynamicToolName(tool.name)),
  );
  const additions: OpenClawDynamicTool[] = [];
  if (
    executionPolicy.nativeToolSurfaceAllowed &&
    input.sandbox?.enabled &&
    input.sandbox.backendId.trim() &&
    input.nativeToolSurfaceEnabled === false &&
    !isCodexDynamicToolExcluded(input.pluginConfig, [
      "exec",
      "sandbox_exec",
      "process",
      "sandbox_process",
    ])
  ) {
    additions.push(createSandboxShellProjection(execTool, "exec"));
    // Core exec already disables backgrounding when process is filtered out.
    if (processTool) {
      additions.push(createSandboxShellProjection(processTool, "process"));
    }
  }
  if (
    input.nativeToolSurfaceEnabled === true &&
    input.sandbox?.enabled !== true &&
    executionPolicy.nativeToolSurfaceAllowed &&
    executionPolicy.effectiveExecHost === "gateway" &&
    !isCodexDynamicToolExcluded(input.pluginConfig, [
      "exec",
      CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
    ]) &&
    !existingNames.has(CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME)
  ) {
    const processAliasAvailable = Boolean(
      processTool &&
      !isCodexDynamicToolExcluded(input.pluginConfig, [
        "process",
        CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
      ]) &&
      !existingNames.has(CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME),
    );
    const createProjection = resolveCodexScheduledToolProjectionFactory(
      input.params.hostCapabilities,
    );
    if (createProjection) {
      additions.push(
        createGatewayExecProjection(createProjection, execTool, {
          processAliasAvailable,
          ...(input.sessionPermissionPolicy?.mode === "guarded" ? { ask: "always" } : {}),
        }),
      );
      if (processAliasAvailable && processTool) {
        additions.push(createGatewayProcessProjection(createProjection, processTool));
      }
    }
  }
  if (
    (executionPolicy.effectiveExecHost === "node" ||
      (executionPolicy.requestedExecHost === "auto" &&
        executionPolicy.effectiveExecHost === "gateway")) &&
    !isCodexDynamicToolExcluded(input.pluginConfig, ["exec", CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME]) &&
    !existingNames.has(CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME)
  ) {
    const nodeExec = await createNodeExecAliasDynamicTool(
      execTool,
      executionPolicy.node,
      input.runAbortController.signal,
      input.nodeExecAvailability,
    );
    if (nodeExec) {
      additions.push(nodeExec);
    }
  }
  return additions.length ? [...filteredTools, ...additions] : filteredTools;
}
function shouldForceMessageTool(params: EmbeddedRunAttemptParams): boolean {
  return (
    params.disableMessageTool !== true && params.sourceReplyDeliveryMode === "message_tool_only"
  );
}
