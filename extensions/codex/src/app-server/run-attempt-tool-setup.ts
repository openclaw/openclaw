import {
  embeddedAgentLog,
  getPluginToolMeta,
  isHostScopedAgentToolActive,
  materializeConfiguredMcpToolsForHarnessRun,
  resolveAgentDir,
  supportsModelTools,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexMcpToolOverridesForAgent } from "openclaw/plugin-sdk/codex-mcp-projection";
import {
  buildDynamicTools,
  formatCodexDynamicToolBuildStageSummary,
  resolveCodexMessageToolProvider,
  shouldWarnCodexDynamicToolBuildStageSummary,
} from "./dynamic-tool-build.js";
import {
  filterCodexDynamicTools,
  resolveCodexDynamicToolsLoadingForRuntime,
} from "./dynamic-tool-profile.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { emitCodexAppServerEvent } from "./run-attempt-lifecycle.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { resolveCodexDynamicToolDirectNames } from "./run-attempt-tools.js";

export async function prepareCodexAttemptTools(runtime: CodexAttemptRuntime) {
  const {
    connection,
    runtimeParams,
    effectiveRuntimeModelId,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    hookChannelId,
  } = runtime;
  const {
    params,
    preDynamicStartupStages,
    mutable,
    startupAuthProfileId,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    agentDir,
  } = connection;
  const preDynamicSummary = preDynamicStartupStages.snapshot();
  if (shouldWarnCodexDynamicToolBuildStageSummary(preDynamicSummary)) {
    embeddedAgentLog.warn(
      `codex app-server pre-dynamic startup timings runId=${params.runId} sessionId=${params.sessionId} totalMs=${preDynamicSummary.totalMs} stages=${formatCodexDynamicToolBuildStageSummary(preDynamicSummary)}`,
      {
        runId: params.runId,
        sessionId: params.sessionId,
        totalMs: preDynamicSummary.totalMs,
        stages: preDynamicSummary.stages,
        hasStartupBinding: Boolean(mutable.startupBinding?.threadId),
        startupAuthProfileId: startupAuthProfileId ?? null,
        nativeToolSurfaceEnabled,
      },
    );
  }
  const toolState = {
    yieldDetected: false,
    persistentWebSearchAllowed: undefined as boolean | undefined,
    webSearchAllowed: false,
  };
  const toolOutcomeOrdinals = new Map<string, number>();
  const suppressedDynamicToolOutcomeOrdinals = new Set<number>();
  const onCodexToolOutcome = params.onToolOutcome
    ? (observation: Parameters<NonNullable<typeof params.onToolOutcome>>[0]) => {
        if (
          observation.toolCallOrdinal !== undefined &&
          suppressedDynamicToolOutcomeOrdinals.has(observation.toolCallOrdinal)
        ) {
          return;
        }
        params.onToolOutcome?.(observation);
      }
    : undefined;
  const baseAllocateToolOutcomeOrdinal = params.allocateToolOutcomeOrdinal;
  const allocateCodexToolOutcomeOrdinal = baseAllocateToolOutcomeOrdinal
    ? (toolCallId?: string): number => {
        const reservedOrdinal = toolCallId ? toolOutcomeOrdinals.get(toolCallId) : undefined;
        if (reservedOrdinal !== undefined) {
          return reservedOrdinal;
        }
        const ordinal = baseAllocateToolOutcomeOrdinal(toolCallId);
        if (toolCallId) {
          toolOutcomeOrdinals.set(toolCallId, ordinal);
        }
        return ordinal;
      }
    : undefined;
  const dynamicToolParams =
    allocateCodexToolOutcomeOrdinal || onCodexToolOutcome
      ? {
          ...runtimeParams,
          ...(allocateCodexToolOutcomeOrdinal
            ? { allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal }
            : {}),
          ...(onCodexToolOutcome ? { onToolOutcome: onCodexToolOutcome } : {}),
        }
      : runtimeParams;
  const computerContextEpoch: {
    value: number;
    frameToolCallId?: string;
    frameImageIdentity?: string;
  } = { value: 0 };
  const cronCreatorToolAllowlist: Array<string | { name: string; pluginId?: string }> = [];
  const commonToolParams = {
    params: dynamicToolParams,
    resolvedWorkspace,
    effectiveWorkspace,
    effectiveCwd,
    sandboxSessionKey,
    sandbox,
    nativeToolSurfaceEnabled,
    nativeProviderWebSearchSupport,
    runAbortController,
    sessionAgentId,
    pluginConfig,
    profilerEnabled,
    onYieldDetected: () => {
      toolState.yieldDetected = true;
    },
    onCodexAppServerEvent: (event: Parameters<typeof emitCodexAppServerEvent>[1]) => {
      void emitCodexAppServerEvent(params, event);
    },
    computerContextEpoch,
  };
  const tools = await buildDynamicTools({
    ...commonToolParams,
    cronCreatorToolAllowlistRef: cronCreatorToolAllowlist,
    onPersistentWebSearchPolicyResolved: (allowed) => {
      toolState.persistentWebSearchAllowed = allowed;
    },
    onWebSearchPolicyResolved: (allowed) => {
      toolState.webSearchAllowed = allowed;
    },
  });
  const registeredTools = await buildDynamicTools({
    ...commonToolParams,
    forceHeartbeatTool: true,
    ignoreDisableMessageTool: true,
    ignoreRuntimePlan: true,
  });
  // OpenClaw-configured MCP is always a dynamic tool surface. Codex-native MCP
  // remains owned by Codex, while this bridge keeps credentials inside OpenClaw.
  const mcpToolsEnabled =
    supportsModelTools(params.model) && params.modelRun !== true && params.promptMode !== "none";
  const configuredMcpTools = await materializeConfiguredMcpToolsForHarnessRun({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: effectiveWorkspace,
    agentDir: agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId),
    cfg: params.config,
    requesterSenderId: params.senderId,
    agentAccountId: params.agentAccountId,
    messageChannel: params.messageChannel ?? params.messageProvider,
    toolOverrides: resolveCodexMcpToolOverridesForAgent(params.config, {
      agentId: sessionAgentId,
      toolOverrides: params.toolOverrides,
    }),
    toolsEnabled: mcpToolsEnabled,
    disableTools: params.disableTools,
    reservedToolNames: [
      ...tools.map((tool) => tool.name),
      ...registeredTools.map((tool) => tool.name),
    ],
    toolsAllow: params.toolsAllow,
    policyContext: {
      config: params.config,
      sessionKey: sandboxSessionKey,
      runSessionKey:
        params.sessionKey && params.sessionKey !== sandboxSessionKey
          ? params.sessionKey
          : undefined,
      sessionId: params.sessionId,
      runId: params.runId,
      agentId: sessionAgentId,
      agentDir: agentDir ?? resolveAgentDir(params.config ?? {}, sessionAgentId),
      agentAccountId: params.agentAccountId,
      scheduledToolPolicy: params.scheduledToolPolicy,
      messageProvider: params.messageProvider ?? params.messageChannel,
      messageChannel: params.messageChannel,
      chatType: params.chatType,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      currentChannelId: params.currentChannelId,
      currentMessagingTarget: params.currentMessagingTarget,
      currentThreadTs: params.currentThreadTs,
      currentMessageId: params.currentMessageId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      memberRoleIds: params.memberRoleIds,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      modelProvider: params.provider,
      modelId: params.modelId,
      modelApi: params.model.api,
      modelContextWindowTokens: params.model.contextWindow,
      modelHasVision: params.model.input?.includes("image") ?? false,
      workspaceDir: effectiveWorkspace,
      cwd: effectiveCwd ?? effectiveWorkspace,
      sandboxToolPolicy: sandbox?.tools,
    },
    warn: (message) => embeddedAgentLog.warn(message),
  });
  try {
    // Restricted dynamic-tool profiles (private QA, exclusion lists) gate scoped
    // MCP tools exactly like every other dynamic tool. Filter both lists with the
    // same rule so execution and advertised specs stay name-aligned.
    const configuredMcpExecutable = configuredMcpTools
      ? filterCodexDynamicTools(configuredMcpTools.tools, pluginConfig)
      : [];
    const configuredMcpAdvertised = configuredMcpTools
      ? filterCodexDynamicTools(configuredMcpTools.advertisedTools, pluginConfig)
      : [];
    const configuredMcpAppTools = configuredMcpTools
      ? filterCodexDynamicTools(configuredMcpTools.appTools, pluginConfig)
      : [];
    configuredMcpTools?.restrictAppTools?.(configuredMcpAppTools);
    const creatorToolNames = new Set(
      cronCreatorToolAllowlist.map((entry) => (typeof entry === "string" ? entry : entry.name)),
    );
    for (const tool of configuredMcpExecutable) {
      if (!creatorToolNames.has(tool.name)) {
        const pluginId = getPluginToolMeta(tool)?.pluginId;
        cronCreatorToolAllowlist.push(pluginId ? { name: tool.name, pluginId } : tool.name);
        creatorToolNames.add(tool.name);
      }
    }
    const toolsWithConfiguredMcp =
      configuredMcpExecutable.length > 0 ? [...tools, ...configuredMcpExecutable] : tools;
    const registeredWithConfiguredMcp =
      configuredMcpAdvertised.length > 0
        ? [...registeredTools, ...configuredMcpAdvertised]
        : registeredTools;
    const toolBridge = createCodexDynamicToolBridge({
      tools: toolsWithConfiguredMcp,
      registeredTools: registeredWithConfiguredMcp,
      signal: runAbortController.signal,
      computerContextEpoch,
      loading: resolveCodexDynamicToolsLoadingForRuntime(pluginConfig, effectiveRuntimeModelId, {
        connectionClass: connection.appServer.connectionClass,
      }),
      directToolNames: resolveCodexDynamicToolDirectNames(
        params,
        isHostScopedAgentToolActive("openclaw"),
      ),
      hookContext: {
        agentId: sessionAgentId,
        config: params.config,
        contextWindowTokens: params.contextTokenBudget ?? params.model.contextWindow,
        workspaceDir: effectiveWorkspace,
        remoteWorkspaceRoot: connection.appServer.remoteWorkspaceRoot,
        remoteWorkspaceRequestTimeoutMs: connection.appServer.requestTimeoutMs,
        sessionId: params.sessionId,
        sessionKey: sandboxSessionKey,
        runId: params.runId,
        channelId: hookChannelId,
        currentChannelProvider: resolveCodexMessageToolProvider(params),
        currentChannelId: params.currentChannelId,
        currentMessagingTarget: params.currentMessagingTarget,
        currentMessageId: params.currentMessageId,
        currentThreadId: params.currentThreadTs,
        replyToMode: params.replyToMode,
        hasRepliedRef: params.hasRepliedRef,
        sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
        onToolOutcome: onCodexToolOutcome,
        allocateToolOutcomeOrdinal: allocateCodexToolOutcomeOrdinal,
      },
    });
    return {
      tools: toolsWithConfiguredMcp,
      registeredTools: registeredWithConfiguredMcp,
      configuredMcpTools,
      dynamicToolParams,
      computerContextEpoch,
      toolBridge,
      toolState,
      toolOutcomeOrdinals,
      suppressedDynamicToolOutcomeOrdinals,
      onCodexToolOutcome,
      allocateCodexToolOutcomeOrdinal,
    };
  } catch (error) {
    await configuredMcpTools?.dispose();
    throw error;
  }
}

export type CodexAttemptTools = Awaited<ReturnType<typeof prepareCodexAttemptTools>>;
