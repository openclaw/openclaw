/**
 * Builds the effective OpenClaw agent tool surface.
 * Assembles core, shell, channel, OpenClaw, plugin, and Tool Search tools, then
 * applies sandbox, profile, provider, sender, group, and sub-agent policy.
 */

import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { mergeGatewayAgentCliPath } from "../infra/openclaw-cli-shim.js";
import { logWarn } from "../logger.js";
import type { PluginHookToolRequesterContext } from "../plugins/hook-types.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import type { SkillSnapshot } from "../skills/types.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import {
  bindAssembledAgentToolActionDescriptor,
  copyAgentToolMetadata,
} from "./agent-tool-metadata.js";
import { createCodingToolsGatewayCaller } from "./agent-tools.caller.js";
import { finalizeAgentTools } from "./agent-tools.finalize.js";
import {
  filterToolsByMessageProvider,
  messageProviderExcludesTool,
} from "./agent-tools.message-provider-policy.js";
import { applyModelProviderToolPolicy } from "./agent-tools.model-provider-policy.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import {
  getActiveAgentRingZeroTools,
  mergeAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolveConfiguredApplyPatchPolicy } from "./apply-patch-policy.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import {
  bindActiveCronCreatorAuthorityResolver,
  bindCronManagementGrant,
} from "./cron-creator-authority-context.js";
import { applyDelegationCapability } from "./delegation-capability.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";
import { resolveImageSanitizationLimits } from "./image-sanitization.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { resolveLocalModelLeanPreserveToolNames } from "./local-model-lean.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { createOpenClawTools, filterToolsByClientCaps } from "./openclaw-tools.js";
import { filterRequesterYieldTools } from "./openclaw-tools.requester-yield.js";
import { applySwarmCollectorToolContract } from "./openclaw-tools.swarm.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import { createEmbeddedMessageInvocationPolicy } from "./scheduled-message-invocation.js";
import { resolveScheduledToolCallerContext } from "./scheduled-tool-policy.js";
import {
  resolveSessionPermissionCoreToolPolicy,
  projectEffectiveExecPolicy,
} from "./session-permission-exec-mode.js";
import { resolveSessionPlacementComputer } from "./session-placement-computer.js";
import { subagentAttachmentRootForRun } from "./subagents/subagent-attachment-paths.js";
import { resolveToolFsConfig } from "./tool-fs-policy.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import {
  expandToolGroups,
  hasRestrictiveAllowPolicy,
  normalizeToolPolicyName,
  replaceWithEffectiveToolAllowlist,
} from "./tool-policy.js";
import {
  createToolSearchTools,
  resolveToolSearchConfig,
  TOOL_CALL_RAW_TOOL_NAME,
  TOOL_DESCRIBE_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { replaceWithEffectiveCronCreatorToolAllowlist } from "./tools/cron-tool.js";
import { prepareSessionPortalToolAccess } from "./tools/session-portal-target.js";

const MEMORY_FLUSH_ALLOWED_TOOL_NAMES = new Set(["read", "write"]);

export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

/** Internal preparation data stays outside the public harness factory options. */
export function createOpenClawCodingToolsInternal(
  options?: OpenClawCodingToolsOptions,
  skillReadResources?: SkillSnapshot["resolvedSkills"],
): AnyAgentTool[] {
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const isMemoryFlushRun = options?.trigger === "memory";
  if (isMemoryFlushRun && !options?.memoryFlushWritePath) {
    throw new Error("memoryFlushWritePath required for memory-triggered tool runs");
  }
  const memoryFlushWritePath = isMemoryFlushRun ? options.memoryFlushWritePath : undefined;
  const cronSelfRemoveOnlyJobId =
    options?.trigger === "cron" && options.jobId?.trim() ? options.jobId.trim() : undefined;
  // Prefer the already-resolved sandbox context policy. Recomputing from
  // sessionKey/config can lose the real sandbox agent when callers pass a
  // legacy alias like `main` instead of an agent session key.
  const capabilityProfile =
    options?.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      config: options?.config,
      sessionKey: options?.sessionKey,
      runSessionKey: options?.runSessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      agentId: options?.policyAgentId ?? options?.agentId,
      agentDir: options?.agentDir,
      agentAccountId: options?.agentAccountId,
      messageProvider: options?.messageProvider,
      messageChannel: options?.messageChannel,
      chatType: options?.chatType,
      messageTo: options?.messageTo,
      messageThreadId: options?.messageThreadId,
      conversationToolPolicy: options?.conversationToolPolicy,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
      currentThreadTs: options?.currentThreadTs,
      currentMessageId: options?.currentMessageId,
      groupId: options?.groupId,
      groupChannel: options?.groupChannel,
      groupSpace: options?.groupSpace,
      memberRoleIds: options?.memberRoleIds,
      spawnedBy: options?.spawnedBy,
      senderId: options?.senderId,
      senderName: options?.senderName,
      senderUsername: options?.senderUsername,
      senderE164: options?.senderE164,
      senderIsOwner: options?.senderIsOwner,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      modelContextWindowTokens: options?.modelContextWindowTokens,
      modelHasVision: options?.modelHasVision,
      workspaceDir: options?.workspaceDir,
      cwd: options?.cwd,
      spawnWorkspaceDir: options?.spawnWorkspaceDir,
      skillsSnapshot: options?.skillsSnapshot,
      sandboxToolPolicy: sandbox?.tools,
      runtimeToolAllowlist: options?.runtimeToolAllowlist,
      inheritRuntimeToolAllowlist: options?.inheritRuntimeToolAllowlist,
      inputProvenance: options?.inputProvenance,
      trustedInternalHandoff: options?.trustedInternalHandoff,
      scheduledToolPolicy: options?.scheduledToolPolicy,
      pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    });
  const { agentId, runtimePluginToolGrant } = capabilityProfile.policy;
  // Tool restrictions can belong to another agent. Never use that owner for
  // credentials, requester identity, or execution hooks.
  const executionAgentId =
    options?.agentId ??
    (options?.runSessionKey
      ? resolveSessionAgentId({ config: options.config, sessionKey: options.runSessionKey })
      : agentId);
  const executionSessionKey = options?.runSessionKey ?? options?.sessionKey;
  const attachmentReadRoot = subagentAttachmentRootForRun(executionAgentId, executionSessionKey);

  const enableHeartbeatTool =
    options?.enableHeartbeatTool === true ||
    (options?.trigger === "heartbeat" &&
      options?.config?.messages?.visibleReplies === "message_tool");
  const forceHeartbeatTool = options?.forceHeartbeatTool === true || enableHeartbeatTool;
  const toolSearchConfig = resolveToolSearchConfig(options?.config);
  const toolSearchControlsEnabled =
    options?.includeToolSearchControls === true && toolSearchConfig.enabled;
  const toolSearchControlAllowlist = toolSearchControlsEnabled
    ? [
        TOOL_SEARCH_CODE_MODE_TOOL_NAME,
        TOOL_SEARCH_RAW_TOOL_NAME,
        TOOL_DESCRIBE_RAW_TOOL_NAME,
        TOOL_CALL_RAW_TOOL_NAME,
      ]
    : [];
  const runtimeToolAllowlistIncludesMessage = expandToolGroups(
    options?.runtimeToolAllowlist ?? [],
  ).some((toolName) => {
    const normalized = normalizeToolPolicyName(toolName);
    return normalized === "*" || normalized === "message";
  });
  // The verified requester profile owns completion authority; its delivery grant
  // stays source-bound even when parent tools remain available to the turn.
  const sourceReplyOnly =
    capabilityProfile.policy.requesterPolicySource === "completion-handoff" &&
    options?.sourceReplyDeliveryMode === "message_tool_only";
  const localModelLeanPreserveToolNames = resolveLocalModelLeanPreserveToolNames({
    toolNames: capabilityProfile.policy.explicitToolOverrideAllowlist,
    forceMessageTool: options?.forceMessageTool,
    sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
  });
  const runtimeProfileAlsoAllow = [
    ...(options && messageToolOwnsVisibleReply(options) ? ["message"] : []),
    ...(runtimeToolAllowlistIncludesMessage ? ["message"] : []),
    ...(forceHeartbeatTool ? [HEARTBEAT_RESPONSE_TOOL_NAME] : []),
    ...toolSearchControlAllowlist,
  ];
  const sandboxWorkspaceMediaReadAllowed = isConversationToolAllowed(capabilityProfile, "read");
  // Borrowed tool restrictions do not transfer ownership of the policy session's processes.
  const scopeKey = resolveProcessToolScopeKey({
    scopeKey: options?.exec?.scopeKey,
    sessionKey: executionSessionKey,
    sessionId: options?.sessionId,
    agentId: executionAgentId,
  });
  if (options?.oneShotCliRun && scopeKey && options.registerRunCleanup) {
    const supervisor = getProcessSupervisor();
    // Sandbox runtimes retain their configured lifetime; host commands still
    // need tree cleanup, including elevated commands from sandboxed sessions.
    const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "owned-only" });
    options.registerRunCleanup(async () => {
      // Transport closure can precede backend finalization. Join both owners
      // before their local artifacts or the invocation state can be released.
      const settled = await Promise.allSettled([cleanupScope(), waitForExecScope(scopeKey)]);
      const failed = settled.find((result) => result.status === "rejected");
      if (failed) {
        throw failed.reason;
      }
    });
  }
  options?.recordToolPrepStage?.("tool-policy");
  const execConfig = resolveExecToolConfig({ cfg: options?.config, agentId });
  const execRuntimeConfig = options?.exec?.config ?? options?.config;
  const preparedRunEnvironment =
    execRuntimeConfig && executionAgentId
      ? prepareGitHubToolEnvironment({
          config: execRuntimeConfig,
          sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig,
          agentId: executionAgentId,
        })
      : undefined;
  const fsConfig = resolveToolFsConfig({ cfg: options?.config, agentId });
  const sessionPermissionPolicy = options?.sessionPermissionPolicy;
  const sessionCoreToolPolicy = sessionPermissionPolicy
    ? resolveSessionPermissionCoreToolPolicy(sessionPermissionPolicy)
    : undefined;
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = capabilityProfile.workspace.workspaceRoot;
  const runtimeRoot = capabilityProfile.workspace.runtimeRoot;
  const codingRoot = sandboxRoot ?? runtimeRoot;
  const containmentRoot = sandboxRoot ?? sessionPermissionPolicy?.root ?? codingRoot;
  const memoryFlushWriteRoot = sandboxRoot ?? workspaceRoot;
  const memoryWriteProvenance = createMemoryWriteProvenanceObserver({
    mutationRoot: sandboxRoot ?? workspaceRoot,
    workspaceDir: sandboxRoot ?? workspaceRoot,
    resolvePath: sandboxFsBridge
      ? (filePath) =>
          resolveSandboxFileIdentity({
            bridge: sandboxFsBridge,
            filePath,
            cwd: sandboxRoot,
            signal: options?.abortSignal,
          })
      : undefined,
    resolveOriginClass: () =>
      options?.senderIsOwner === false || options?.isTurnTainted?.() === true
        ? "untrusted"
        : "agent",
    sessionId: options?.sessionId,
    sessionKey: options?.runSessionKey ?? options?.sessionKey,
  });
  const includeCoreTools = options?.includeCoreTools !== false;
  const toolConstructionPlan = options?.toolConstructionPlan ?? {
    includeBaseCodingTools: includeCoreTools,
    includeShellTools: includeCoreTools,
    includeChannelTools: includeCoreTools,
    includeOpenClawTools: includeCoreTools,
    includePluginTools: true,
  };
  const includeBaseCodingTools = includeCoreTools && toolConstructionPlan.includeBaseCodingTools;
  const includeShellTools = includeCoreTools && toolConstructionPlan.includeShellTools;
  const includeOpenClawTools = includeCoreTools && toolConstructionPlan.includeOpenClawTools;
  const includeChannelTools = toolConstructionPlan.includeChannelTools;
  const includePluginTools = toolConstructionPlan.includePluginTools;
  const workspaceOnly =
    options?.requireWorkspaceOnly === true ||
    isMemoryFlushRun ||
    (sessionCoreToolPolicy?.workspaceOnly ?? fsConfig.workspaceOnly === true);
  const fsPolicy = {
    workspaceOnly,
    ...(sessionPermissionPolicy ? { root: sessionPermissionPolicy.root } : {}),
    ...(attachmentReadRoot ? { readOnlyRoots: [attachmentReadRoot] } : {}),
  };
  const readOnly = sessionCoreToolPolicy?.readOnly ?? false;
  const applyPatchPolicy = resolveConfiguredApplyPatchPolicy({
    config: execConfig.applyPatch,
    workspaceOnly,
    readOnly,
    requireWorkspaceOnly: options?.requireWorkspaceOnly === true,
    sessionPolicy: sessionCoreToolPolicy,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });

  const imageSanitization = resolveImageSanitizationLimits(options?.config);
  options?.recordToolPrepStage?.("workspace-policy");
  const execDefaults = options?.exec ?? {};
  const scheduledExecTarget = options?.scheduledToolPolicy?.execTarget;
  const effectiveExecPolicy = projectEffectiveExecPolicy({
    base: execConfig,
    overrides: options?.exec,
    permissionPolicy: sessionPermissionPolicy,
    scheduledExecTarget,
  });
  const processToolAvailabilityRef: NonNullable<ExecToolDefaults["processToolAvailabilityRef"]> =
    {};
  const coreTools = createCoreCodingTools({
    abortSignal: options?.abortSignal,
    attachmentReadRoot,
    codingRoot,
    containmentRoot,
    includeBaseCodingTools,
    shellTools: includeShellTools ? "full" : "disabled",
    workspaceOnly,
    readOnly,
    sandbox,
    skillsSnapshot: options?.skillsSnapshot,
    skillReadResources,
    skillInstructionPaths: options?.skillUsagePaths?.map((entry) => entry.readPath),
    skillInstructionDeliveryCache: options?.skillInstructionDeliveryCache,
    modelContextWindowTokens: options?.modelContextWindowTokens,
    imageSanitization,
    modelHasVision: options?.modelHasVision,
    memoryWriteProvenance,
    ...applyPatchPolicy,
    execDefaults: {
      ...execDefaults,
      ...effectiveExecPolicy,
      config: execRuntimeConfig,
      preparedRunEnvironment,
      reviewer: options?.exec?.reviewer ?? execConfig.reviewer,
      reviewTranscript: options?.exec?.reviewTranscript,
      trigger: options?.trigger,
      node: options?.exec?.node ?? execConfig.node,
      pathPrepend: mergeGatewayAgentCliPath(options?.exec?.pathPrepend ?? execConfig.pathPrepend),
      safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
      strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
      commandHighlighting: options?.exec?.commandHighlighting ?? execConfig.commandHighlighting,
      safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
      safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
      agentId,
      cleanupMs: options?.exec?.cleanupMs ?? execConfig.cleanupMs,
      processToolAvailabilityRef,
      scopeKey,
      sessionKey: options?.sessionKey,
      runId: options?.runId,
      operationalRunInstance: options?.operationalRunInstance,
      runSessionKey: executionSessionKey,
      sessionId: options?.sessionId,
      sessionStore: options?.config?.session?.store,
      eventRouting: resolveEventSessionRoutingPolicy({
        cfg: options?.config,
        sessionKey: options?.runSessionKey ?? options?.sessionKey,
        channel: options?.messageProvider,
        accountId: options?.agentAccountId,
      }),
      messageProvider: options?.messageProvider,
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      channelContext: options?.channelContext,
      accountId: options?.agentAccountId,
      approvalReviewerDeviceId: options?.approvalReviewerDeviceId,
      nonInteractiveApproval: options?.swarmCollector,
      backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
      timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
      approvalRunningNoticeMs:
        options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
      notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
      notifyOnExitEmptySuccess:
        options?.exec?.notifyOnExitEmptySuccess ?? execConfig.notifyOnExitEmptySuccess,
    },
    processDefaults: {
      scopeKey,
    },
    recordToolPrepStage: options?.recordToolPrepStage,
  });
  const cronCreatorAuthorityResolver = bindActiveCronCreatorAuthorityResolver(options?.runId);
  const cronManagementGrant = bindCronManagementGrant(options?.runId);
  const { sessionPortalTarget, ownerOnlyCoreToolDenylist, ownerOnlyCoreToolPolicy } =
    prepareSessionPortalToolAccess({
      sessionKey: executionSessionKey,
      agentId: executionAgentId,
      sessionId: options?.sessionId,
      senderIsOwner: options?.senderIsOwner,
      sandboxed: Boolean(sandbox),
      hasAutomationGrant: Boolean(cronCreatorAuthorityResolver || cronManagementGrant),
    });
  const pluginToolAllowlist = appendRuntimePluginToolGrant(
    capabilityProfile.policy.explicitToolAllowlist,
    runtimePluginToolGrant,
  );
  const pluginToolDenylist = [
    ...capabilityProfile.policy.explicitToolDenylist,
    ...ownerOnlyCoreToolDenylist,
  ];
  const inheritedToolDenylist = [...pluginToolDenylist];
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the actual parent tool surface.
  const inheritedToolAllowlist = options?.inheritedToolAllowlistRef ?? [];
  const toolPolicyInheritanceSources = capabilityProfile.policy.inheritancePolicies;
  const shouldInheritEffectiveToolAllowlist =
    toolPolicyInheritanceSources.some(hasRestrictiveAllowPolicy);
  const cronCreatorToolAllowlist = options?.cronCreatorToolAllowlistRef ?? [];
  const cronCreatorToolAllowlistCaptureRef = options?.cronCreatorToolAllowlistCaptureRef;
  const gatewayCaller = resolveScheduledToolCallerContext({
    scheduledToolPolicy: options?.scheduledToolPolicy,
    accountId: options?.agentAccountId,
    channel: resolveGatewayMessageChannel(options?.messageChannel ?? options?.messageProvider),
  });
  // Plugin-only plans bypass createOpenClawTools, so the capability gate must
  // apply here too or narrow allowlists leak gated tools onto capless surfaces.
  const wrapGatewayCaller = createCodingToolsGatewayCaller({
    options,
    agentId: executionAgentId,
    sessionKey: executionSessionKey,
    accountId: gatewayCaller.accountId,
    capabilityProfile,
  });
  const pluginToolsOnly = filterToolsByClientCaps(
    includeOpenClawTools || !includePluginTools
      ? []
      : resolveOpenClawPluginToolsForOptions({
          options: {
            agentSessionKey: options?.sessionKey,
            runSessionKey: options?.runSessionKey,
            runId: options?.runId,
            agentChannel: resolveGatewayMessageChannel(
              options?.messageChannel ?? options?.messageProvider,
            ),
            agentAccountId: options?.agentAccountId,
            agentTo: options?.messageTo,
            agentThreadId: options?.messageThreadId,
            nativeChannelId: options?.nativeChannelId,
            messageActionTurnCapability: options?.messageActionTurnCapability,
            agentDir: options?.agentDir,
            preparedModelRuntime: options?.preparedModelRuntime,
            workspaceDir: workspaceRoot,
            config: options?.config,
            fsPolicy,
            requesterSenderId: options?.senderId,
            senderIsOwner: options?.senderIsOwner,
            sessionId: options?.sessionId,
            conversationRecall: options?.conversationRecall,
            oneShotCliRun: options?.oneShotCliRun,
            sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
            allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
            sandboxed: Boolean(sandbox),
            pluginToolAllowlist,
            pluginToolDenylist,
            currentChannelId: options?.currentChannelId,
            currentMessagingTarget: options?.currentMessagingTarget,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            modelHasVision: options?.modelHasVision,
            requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
            disableMessageTool: options?.disableMessageTool || options?.swarmCollector,
            requesterAgentIdOverride: executionAgentId,
            allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
            clientCaps: options?.clientCaps,
            toolBindings: options?.toolBindings,
            authProfileStore: options?.authProfileStore,
          },
          resolvedConfig: options?.config,
        }),
    options?.clientCaps,
  );
  const ringZeroTools = includeOpenClawTools ? getActiveAgentRingZeroTools() : [];
  const toolSearchTools =
    toolSearchControlsEnabled && ringZeroTools.length === 0
      ? createToolSearchTools({
          config: options?.config,
          runtimeConfig: options?.config,
          agentId,
          sessionKey: options?.sessionKey,
          sessionId: options?.sessionId,
          runId: options?.runId,
          catalogRef: options?.toolSearchCatalogRef,
          codeModeSkills: options?.codeModeSkills,
          abortSignal: options?.abortSignal,
          executeTool: options?.toolSearchCatalogExecutor,
        })
      : [];
  const scheduledCoreTools = scheduledExecTarget
    ? coreTools.map((tool) =>
        tool.name === "exec"
          ? copyAgentToolMetadata(tool, pinExecToolTarget(tool, scheduledExecTarget))
          : tool,
      )
    : coreTools;
  const messageInvocationPolicy = createEmbeddedMessageInvocationPolicy({
    config: options?.config,
    capabilityProfile,
    runtimeProfileAlsoAllow,
    toolSearchControlAllowlist,
    scheduledToolPolicy: options?.scheduledToolPolicy,
    pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    ownerOnlyCoreToolPolicy,
    catalog: () => ({
      tools: toolsForModelProvider,
      declaredToolAllowlist,
      unavailableCoreToolReason,
    }),
    isAvailable: (): boolean => authorizedTools.some((tool) => tool.name === "message"),
  });
  const tools: AnyAgentTool[] = [
    ...scheduledCoreTools,
    // Include channel-defined agent tools (login, etc.).
    ...(includeChannelTools ? listChannelAgentTools({ cfg: options?.config }) : []),
    ...(includeOpenClawTools
      ? mergeAgentRingZeroTools(
          ringZeroTools,
          createOpenClawTools({
            sessionPortalTarget,
            ...(options?.systemAgentTool ? { systemAgentTool: options.systemAgentTool } : {}),
            sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
            allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
            agentSessionKey: options?.sessionKey,
            runId: options?.runId,
            ...(options?.questionPrompt ? { questionPrompt: options.questionPrompt } : {}),
            requesterThinkingLevel: options?.requesterThinkingLevel,
            requesterModel: options?.requesterModel,
            sessionPermissionPolicy,
            execSession: sessionPermissionPolicy
              ? { permissionMode: sessionPermissionPolicy.mode }
              : undefined,
            execOverrides: {
              host: effectiveExecPolicy.host,
              mode: effectiveExecPolicy.mode,
              security: effectiveExecPolicy.security,
              ask: effectiveExecPolicy.ask,
              node: options?.exec?.node ?? execConfig.node,
            },
            approvalReviewerDeviceIds: options?.approvalReviewerDeviceId
              ? [options.approvalReviewerDeviceId]
              : undefined,
            runSessionKey: options?.runSessionKey,
            agentChannel: resolveGatewayMessageChannel(
              options?.messageChannel ?? options?.messageProvider,
            ),
            agentAccountId: options?.agentAccountId,
            gatewayCallerAccountId: gatewayCaller.accountId,
            gatewayCallerChannel: gatewayCaller.channel,
            gatewayCallerLocal: gatewayCaller.local,
            gatewayCallerScheduled: gatewayCaller.scheduled,
            agentTo: options?.messageTo,
            agentThreadId: options?.messageThreadId,
            nativeChannelId: options?.nativeChannelId,
            messageActionTurnCapability: options?.messageActionTurnCapability,
            admitScheduledMessageInvocation: options?.messageActionTurnCapability
              ? messageInvocationPolicy.admit
              : undefined,
            agentGroupId: options?.groupId ?? null,
            agentGroupChannel: options?.groupChannel ?? null,
            agentGroupSpace: options?.groupSpace ?? null,
            agentMemberRoleIds: options?.memberRoleIds,
            agentDir: options?.agentDir,
            preparedModelRuntime: options?.preparedModelRuntime,
            sandboxRoot,
            sandboxContainerWorkdir: sandbox?.containerWorkdir,
            sandboxFsBridge,
            sandboxReadOnlyResourceMounts: sandbox?.readOnlyResourceMounts,
            stagedMediaPaths: options?.stagedMediaPaths,
            sandboxWorkspaceMediaReadAllowed,
            fsPolicy,
            workspaceDir: workspaceRoot,
            spawnWorkspaceDir: capabilityProfile.workspace.spawnWorkspaceRoot,
            // Sandboxes execute against copied roots, but accepted suggestions create host
            // worktrees. Unsandboxed task-repo sessions must stay on their runtime cwd.
            cwd: sandbox
              ? (capabilityProfile.workspace.spawnWorkspaceRoot ?? runtimeRoot)
              : runtimeRoot,
            sandboxed: Boolean(sandbox),
            config: options?.config,
            sessionConfigSource: options?.sessionConfigSource,
            sessionReadScopeKey: options?.sessionReadScopeKey,
            webFetchHostnameAllowlistRef: options?.webFetchHostnameAllowlistRef,
            webSearchEnabled: options?.webSearchEnabled,
            clientCaps: options?.clientCaps,
            pinnedWidgetAuthoring: options?.pinnedWidgetAuthoring,
            gatewayUiCommandTarget: options?.gatewayUiCommandTarget,
            toolBindings: options?.toolBindings,
            pluginToolAllowlist,
            pluginToolDenylist,
            gatewayConfigReadAllowed: capabilityProfile.policy.gatewayConfigReadAllowed,
            runtimeToolAllowlist: options?.runtimeToolAllowlist,
            githubPublicationAvailable: options?.githubPublicationAvailable,
            cronCreatorToolAllowlist,
            cronCreatorToolAllowlistCaptureRef,
            resolveCronCreatorToolAuthority: cronCreatorAuthorityResolver,
            cronCreatorAuthorityUnavailableReason: options?.cronCreatorAuthorityUnavailableReason,
            currentChannelId: options?.currentChannelId,
            currentChatType: options?.chatType,
            currentMessagingTarget: options?.currentMessagingTarget,
            currentThreadTs: options?.currentThreadTs,
            currentMessageId: options?.currentMessageId,
            currentInboundAudio: options?.currentInboundAudio,
            hasCurrentInboundAudio: options?.hasCurrentInboundAudio,
            modelProvider: options?.modelProvider,
            modelId: options?.modelId,
            modelContextWindowTokens: options?.modelContextWindowTokens,
            skillWorkshop: options?.skillWorkshop,
            replyToMode: options?.replyToMode,
            hasRepliedRef: options?.hasRepliedRef,
            modelHasVision: options?.modelHasVision,
            computerContextEpoch: options?.computerContextEpoch,
            computerTransport:
              options?.computerTransport === null
                ? null
                : (options?.computerTransport ??
                  resolveSessionPlacementComputer(options?.operationalRunInstance)),
            pairedNodeComputerUse: options?.pairedNodeComputerUse,
            registerRunCleanup: options?.registerRunCleanup,
            requireExplicitMessageTarget: options?.requireExplicitMessageTarget,
            sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
            sourceReplyOnly,
            taskSuggestionDeliveryMode: options?.taskSuggestionDeliveryMode,
            inboundEventKind: options?.inboundEventKind,
            disableMessageTool: options?.disableMessageTool || options?.swarmCollector,
            swarmCollector: options?.swarmCollector,
            swarmOutputSchema: options?.swarmOutputSchema,
            enableHeartbeatTool,
            disablePluginTools: !includePluginTools,
            wrapBeforeToolCallHook: false,
            ...(cronSelfRemoveOnlyJobId ? { cronSelfRemoveOnlyJobId } : {}),
            requesterAgentIdOverride: executionAgentId,
            requesterSenderId: options?.senderId,
            senderIsOwner: options?.senderIsOwner,
            authProfileStore: options?.authProfileStore,
            sessionId: options?.sessionId,
            conversationRecall: options?.conversationRecall,
            oneShotCliRun: options?.oneShotCliRun,
            inheritedToolAllowlist,
            inheritedToolDenylist,
            onYield: options?.onYield,
            claimYieldCompletion: options?.claimYieldCompletion,
            processScopeKey: scopeKey,
            allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
            recordToolPrepStage: options?.recordToolPrepStage,
          }),
        )
      : pluginToolsOnly),
    ...toolSearchTools,
  ];
  options?.recordToolPrepStage?.("openclaw-tools");
  const swarmStructuredOutputTool =
    options?.swarmCollector && options.swarmOutputSchema
      ? tools.find((tool) => tool.name === "structured_output")
      : undefined;
  const toolsForMemoryFlush: AnyAgentTool[] = isMemoryFlushRun && memoryFlushWritePath ? [] : tools;
  if (isMemoryFlushRun && memoryFlushWritePath) {
    for (const tool of tools) {
      if (!MEMORY_FLUSH_ALLOWED_TOOL_NAMES.has(tool.name)) {
        continue;
      }
      if (tool.name === "write") {
        toolsForMemoryFlush.push(
          wrapToolMemoryFlushAppendOnlyWrite(tool, {
            root: memoryFlushWriteRoot,
            relativePath: memoryFlushWritePath,
            memoryWriteProvenance,
            containerWorkdir: sandbox?.containerWorkdir,
            sandbox:
              sandboxRoot && sandboxFsBridge
                ? { root: sandboxRoot, bridge: sandboxFsBridge }
                : undefined,
          }),
        );
        continue;
      }
      toolsForMemoryFlush.push(tool);
    }
  }
  const unavailableCoreToolReason =
    isMemoryFlushRun && memoryFlushWritePath
      ? "memory-triggered compaction runs expose only read and append-only write"
      : undefined;
  const toolsForMessageProvider = filterToolsByMessageProvider(
    toolsForMemoryFlush,
    options?.toolPolicyMessageProvider ?? options?.messageProvider,
  );
  options?.recordToolPrepStage?.("message-provider-policy");
  const toolsForModelProvider = applyModelProviderToolPolicy(toolsForMessageProvider, {
    ...options,
    agentId,
    localModelLeanPreserveToolNames,
  });
  options?.recordToolPrepStage?.("model-provider-policy");
  const declaredToolAllowlist = buildDeclaredToolAllowlistContext({
    config: options?.config,
    metadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    workspaceDir: workspaceRoot,
    toolDenylist: pluginToolDenylist,
  });
  // Sender identity is primarily command/action auth, with one Gateway parity exception:
  // explicit non-owner callers never receive owner-only control-plane core tools.
  const subagentFiltered = messageInvocationPolicy.filter();
  // Host-bound ring-zero tools carry their own authority checks. Agent policy
  // must not deadlock setup, but the tools still receive schema/hook wrappers.
  const authorizedTools = applySwarmCollectorToolContract(
    applyDelegationCapability(
      mergeAgentRingZeroTools(ringZeroTools, subagentFiltered),
      options?.delegationCapability,
    ),
    {
      swarmCollector: options?.swarmCollector,
      structuredOutputTool: swarmStructuredOutputTool,
    },
  );
  authorizedTools.forEach(bindAssembledAgentToolActionDescriptor);
  processToolAvailabilityRef.value = authorizedTools.some((tool) => tool.name === "process");
  if (shouldInheritEffectiveToolAllowlist) {
    // Snapshot exporter only: this copies authorizedTools for descendants and
    // never filters the mandatory structured_output tool from this turn.
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, authorizedTools);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, authorizedTools, (tool) =>
    getPluginToolMeta(tool),
  );
  if (
    isMemoryFlushRun &&
    memoryFlushWritePath &&
    !authorizedTools.some((tool) => tool.name === "write") &&
    // A transport whose allowlist never carries `write`, such as node, is an intended
    // configuration, not a lost writer, so it stays quiet instead of warning per flush.
    !messageProviderExcludesTool(
      options?.toolPolicyMessageProvider ?? options?.messageProvider,
      "write",
    )
  ) {
    // Checked on the final authorized list, not the earlier flush surface: tools.deny,
    // the model-provider policy and the rest of the pipeline all run after that surface
    // is built, so a flush can hold `write` there and lose it here.
    // Otherwise the run completes normally, the model reports the save as done, and the
    // memory is lost with no record that it was never persisted. The text names no
    // single config key because any of those filters can be the one that removed it.
    logWarn(
      `memory flush cannot persist ${memoryFlushWritePath}: no write tool survived this agent's tool policy, so this run will not save anything.`,
    );
  }
  options?.recordToolPrepStage?.("authorization-policy");
  const turnSourceChannel = options?.messageChannel ?? options?.messageProvider;
  const turnSourceTo = options?.currentMessagingTarget ?? options?.currentChannelId;
  const requester = {
    ...(turnSourceChannel ? { channel: turnSourceChannel } : {}),
    ...(options?.agentAccountId ? { accountId: options.agentAccountId } : {}),
    ...(options?.senderId ? { senderId: options.senderId } : {}),
    ...(options?.senderIsOwner !== undefined ? { senderIsOwner: options.senderIsOwner } : {}),
    ...(options?.memberRoleIds?.length ? { roleIds: [...options.memberRoleIds] } : {}),
  } satisfies PluginHookToolRequesterContext;
  const hasRequester = Object.keys(requester).length > 0;
  const hookContext = {
    agentId: executionAgentId,
    ...(options?.config ? { config: options.config } : {}),
    cwd: codingRoot,
    workspaceDir: workspaceRoot,
    ...(options?.skillsSnapshot ? { skillsSnapshot: options.skillsSnapshot } : {}),
    ...(options?.skillUsagePaths ? { skillUsagePaths: options.skillUsagePaths } : {}),
    ...(sandboxRoot && sandboxFsBridge && allowWorkspaceWrites
      ? { sandbox: { root: sandboxRoot, bridge: sandboxFsBridge } }
      : {}),
    sessionKey: executionSessionKey,
    sessionId: options?.sessionId,
    runId: options?.runId,
    trigger: options?.trigger,
    approvalReviewerDeviceId: options?.approvalReviewerDeviceId,
    channelId: options?.hookChannelId ?? options?.currentChannelId,
    ...(hasRequester ? { requester } : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(options?.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
    ...(options?.currentThreadTs ? { turnSourceThreadId: options.currentThreadTs } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId }),
    onToolOutcome: options?.onToolOutcome,
    allocateToolOutcomeOrdinal: options?.allocateToolOutcomeOrdinal,
  };
  // NOTE: Keep canonical (lowercase) tool names here. Provider transports remap on the wire.
  return finalizeAgentTools({
    tools: filterRequesterYieldTools(authorizedTools, executionSessionKey),
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
    modelCompat: options?.modelCompat,
    hookContext,
    wrapBeforeToolCallHook: options?.wrapBeforeToolCallHook,
    emitBeforeToolCallDiagnostics: options?.emitBeforeToolCallDiagnostics,
    ...(options?.swarmCollector ? { approvalMode: "deny" as const } : {}),
    abortSignal: options?.abortSignal,
    recordToolPrepStage: options?.recordToolPrepStage,
  }).map(wrapGatewayCaller);
}

/** Build the SDK tool list without exposing core-only auxiliary read scope. */
export function createOpenClawCodingTools(
  options?: Omit<OpenClawCodingToolsOptions, "sessionReadScopeKey">,
): AnyAgentTool[] {
  return createOpenClawCodingToolsInternal(options);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
