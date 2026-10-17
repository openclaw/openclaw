import { HEARTBEAT_RESPONSE_TOOL_NAME } from "../auto-reply/heartbeat-tool-response.js";
import { messageToolOwnsVisibleReply } from "../auto-reply/source-reply-delivery-mode.js";
import { createRuntimeConfigReader } from "../config/runtime-snapshot.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { mergeGatewayAgentCliPath } from "../infra/openclaw-cli-shim.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { appendRuntimePluginToolGrant } from "../plugins/tool-grant-allowlist.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
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
  assertMemoryFlushPersistenceToolAvailable,
  projectMemoryFlushTools,
  resolveMemoryFlushToolSetup,
  warnIfMemoryFlushFileWriterUnavailable,
} from "./agent-tools.memory-flush.js";
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import { applyModelProviderToolPolicy } from "./agent-tools.model-provider-policy.js";
import type {
  InternalCodingToolsOptions,
  PluginCodingToolsOptions,
} from "./agent-tools.options.js";
import {
  getActiveAgentRingZeroTools,
  mergeAgentRingZeroTools,
} from "./agent-tools.ring-zero-context.js";
import { resolveTurnToolSurface } from "./agent-tools.turn-authority.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resolveProcessToolScopeKey } from "./bash-process-scope.js";
import { listChannelAgentTools } from "./channel-tools.js";
import {
  prepareConversationCapabilityProfile,
  prepareDelegatedToolDenyFloor,
  resolveConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { applyDelegationCapability } from "./delegation-capability.js";
import { pinExecToolTarget } from "./exec-tool-target-pinning.js";
import { buildHarnessHostRequester } from "./harness/host-requester.js";
import { resolveExecToolConfig } from "./lazy-exec-tool.js";
import { resolveLocalModelLeanPreserveToolNames } from "./local-model-lean.js";
import { createMemoryWriteProvenanceObserver } from "./memory-write-provenance.js";
import {
  resolveOpenClawPluginToolsForOptions,
  resolveOpenClawPluginToolsForOptionsAsync,
} from "./openclaw-plugin-tools.js";
import {
  createOpenClawTools,
  createOpenClawToolsWithPreparation,
  filterToolsByClientCaps,
} from "./openclaw-tools.js";
import { filterRequesterYieldTools } from "./openclaw-tools.requester-yield.js";
import { applySwarmCollectorToolContract } from "./openclaw-tools.swarm.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { prepareCoreToolPolicy } from "./prepared-tool-surface.js";
import { resolveSandboxFileIdentity } from "./sandbox/file-mutation-identity.js";
import { createEmbeddedMessageInvocationPolicy } from "./scheduled-message-invocation.js";
import { resolveScheduledToolCallerContext } from "./scheduled-tool-policy.js";
import { projectEffectiveExecPolicy } from "./session-permission-exec-mode.js";
import { resolveSessionPlacementComputer } from "./session-placement-computer.js";
import { withLegacySessionCapabilityRead } from "./subagents/spawn/subagent-session-store-legacy.js";
import { subagentAttachmentRootForRun } from "./subagents/subagent-attachment-paths.js";
import {
  withPreparedToolConstruction,
  type ToolConstructionPreparationOptions,
} from "./tool-construction-preparation.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { buildDeclaredToolAllowlistContext } from "./tool-policy-declared-context.js";
import type { ToolPolicyFilterEvent } from "./tool-policy-pipeline.js";
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
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "./tool-search.js";
import { replaceWithEffectiveCronCreatorToolAllowlist } from "./tools/cron-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";
import { resolveHeartbeatTools } from "./tools/heartbeat-response-tool.js";
import { prepareSessionPortalToolAccess } from "./tools/session-portal-target.js";

export { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";

// Both SDK paths assemble the same options; only compatibility resolves delegate policy synchronously.
function* assembleOpenClawCodingTools(
  options?: InternalCodingToolsOptions,
  skillReadResources?: SkillSnapshot["resolvedSkills"],
  onPolicyFilter?: (event: ToolPolicyFilterEvent) => void,
  preparedSurface?: { tools: AnyAgentTool[]; policy: ReturnType<typeof prepareCoreToolPolicy> },
): Generator<
  | OpenClawToolsOptions
  | { pluginTools: Parameters<typeof resolveOpenClawPluginToolsForOptions>[0] },
  AnyAgentTool[],
  AnyAgentTool[]
> {
  const preparedTools = preparedSurface?.tools;
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const { isMemoryFlushRun, memoryFlush, memoryFlushWritePath } =
    resolveMemoryFlushToolSetup(options);
  const cronSelfRemoveOnlyJobId =
    options?.trigger === "cron" && options.jobId?.trim() ? options.jobId.trim() : undefined;
  // Prefer the already-resolved sandbox context policy. Recomputing from
  // sessionKey/config can lose the real sandbox agent when callers pass a
  // legacy alias like `main` instead of an agent session key.
  const capabilityProfile =
    options?.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      ...options,
      agentId: options?.policyAgentId ?? options?.agentId,
      sandboxToolPolicy: sandbox?.tools,
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

  const { enableHeartbeatTool, offerHeartbeatTool } = resolveHeartbeatTools(options, agentId);
  const toolSearchConfig = resolveToolSearchConfig(options?.config);
  const toolSearchControlsEnabled =
    options?.includeToolSearchControls === true && toolSearchConfig.enabled;
  const toolSearchControlAllowlist = toolSearchControlsEnabled
    ? [TOOL_SEARCH_RAW_TOOL_NAME, TOOL_DESCRIBE_RAW_TOOL_NAME, TOOL_CALL_RAW_TOOL_NAME]
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
    ...(offerHeartbeatTool ? [HEARTBEAT_RESPONSE_TOOL_NAME] : []),
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
  const sessionPermissionPolicy = options?.sessionPermissionPolicy;
  const coreToolPolicy =
    preparedSurface?.policy ?? prepareCoreToolPolicy({ ...options, agentId }, execConfig);
  const sandboxRoot = sandbox?.workspaceDir;
  const sandboxFsBridge = sandbox?.fsBridge;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const { workspaceRoot, runtimeRoot } = capabilityProfile.workspace;
  const codingRoot = sandboxRoot ?? runtimeRoot;
  const containmentRoot = sandboxRoot ?? sessionPermissionPolicy?.root ?? codingRoot;
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
  const fsPolicy = {
    workspaceOnly: coreToolPolicy.workspaceOnly,
    ...(sessionPermissionPolicy ? { root: sessionPermissionPolicy.root } : {}),
    ...(attachmentReadRoot ? { readOnlyRoots: [attachmentReadRoot] } : {}),
  };
  options?.recordToolPrepStage?.("workspace-policy");
  const scheduledExecTarget = options?.scheduledToolPolicy?.execTarget;
  const effectiveExecPolicy = projectEffectiveExecPolicy({
    base: execConfig,
    overrides: options?.exec,
    permissionPolicy: sessionPermissionPolicy,
    scheduledExecTarget,
  });
  const coreTools =
    preparedTools === undefined
      ? createCoreCodingTools({
          abortSignal: options?.abortSignal,
          attachmentReadRoot,
          codingRoot,
          containmentRoot,
          includeBaseCodingTools,
          shellTools: includeShellTools ? "full" : "disabled",
          ...coreToolPolicy,
          sandbox,
          skillsSnapshot: options?.skillsSnapshot,
          skillReadResources,
          skillInstructionPaths: options?.skillUsagePaths?.map((entry) => entry.readPath),
          skillInstructionDeliveryCache: options?.skillInstructionDeliveryCache,
          memoryWriteProvenance,
          execDefaults: {
            ...options?.exec,
            ...effectiveExecPolicy,
            config: options?.exec?.config ?? options?.config,
            preparedRunEnvironment: options?.exec?.preparedRunEnvironment,
            reviewer: options?.exec?.reviewer ?? execConfig.reviewer,
            reviewTranscript: options?.exec?.reviewTranscript,
            trigger: options?.trigger,
            continuesConversation: options?.continuesConversation,
            node: options?.exec?.node ?? execConfig.node,
            pathPrepend: mergeGatewayAgentCliPath(
              options?.exec?.pathPrepend ?? execConfig.pathPrepend,
            ),
            safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
            strictInlineEval: options?.exec?.strictInlineEval ?? execConfig.strictInlineEval,
            commandHighlighting:
              options?.exec?.commandHighlighting ?? execConfig.commandHighlighting,
            safeBinTrustedDirs: options?.exec?.safeBinTrustedDirs ?? execConfig.safeBinTrustedDirs,
            safeBinProfiles: options?.exec?.safeBinProfiles ?? execConfig.safeBinProfiles,
            agentId,
            executionAgentId,
            cleanupMs: options?.exec?.cleanupMs ?? execConfig.cleanupMs,
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
        })
      : [];
  const { sessionPortalTarget, ownerOnlyCoreToolDenylist, cronCreatorAuthorityResolver } =
    prepareSessionPortalToolAccess({
      sessionKey: executionSessionKey,
      agentId: executionAgentId,
      sessionId: options?.sessionId,
      senderIsOwner: options?.senderIsOwner,
      sandboxed: Boolean(sandbox),
      runId: options?.runId,
      cronSelfRemoveOnlyJobId,
    });
  const pluginToolAllowlist = appendRuntimePluginToolGrant(
    capabilityProfile.policy.explicitToolAllowlist,
    runtimePluginToolGrant,
  );
  // Owner-only tools stay offered (resolveTurnToolSurface gates their calls);
  // descendants and captured allowlists never inherit them.
  const pluginToolDenylist = [...capabilityProfile.policy.explicitToolDenylist];
  const requesterToolDenylist = [...pluginToolDenylist, ...ownerOnlyCoreToolDenylist];
  const inheritedToolDenylist = [
    ...requesterToolDenylist,
    ...(capabilityProfile.policy.inheritedToolPolicyForSpawn?.deny ?? []),
  ];
  const delegatedToolDenyFloor = prepareDelegatedToolDenyFloor(
    capabilityProfile,
    ownerOnlyCoreToolDenylist,
  );
  // Passed by reference to sessions_spawn and populated after the final policy
  // pass so child sessions inherit the parent's tool policy.
  const inheritedToolAllowlist = options?.inheritedToolAllowlistRef ?? [];
  const shouldInheritEffectiveToolAllowlist =
    capabilityProfile.policy.inheritancePolicies.some(hasRestrictiveAllowPolicy);
  // A new managed child has its own publication workspace. Run the real tool
  // through all parent policies before capturing it, without exposing it here.
  const unavailablePublicationTool =
    (shouldInheritEffectiveToolAllowlist || options?.inheritedPublicationToolRef) &&
    includeOpenClawTools &&
    options?.githubPublicationAvailable === false
      ? createGitHubPublishTool()
      : undefined;
  const cronCreatorToolAllowlist = options?.cronCreatorToolAllowlistRef ?? [];
  const gatewayCaller = resolveScheduledToolCallerContext({
    scheduledToolPolicy: options?.scheduledToolPolicy,
    accountId: options?.agentAccountId,
    channel: resolveGatewayMessageChannel(options?.messageChannel ?? options?.messageProvider),
  });
  const pluginToolOptions = {
    ...options,
    agentSessionKey: options?.sessionKey,
    agentChannel: resolveGatewayMessageChannel(options?.messageChannel ?? options?.messageProvider),
    agentTo: options?.messageTo,
    agentThreadId: options?.messageThreadId,
    workspaceDir: workspaceRoot,
    fsPolicy,
    requesterSenderId: options?.senderId,
    memoryFlush,
    sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
    allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
    sandboxed: Boolean(sandbox),
    pluginToolAllowlist,
    pluginToolDenylist,
    disableMessageTool: options?.disableMessageTool || options?.swarmCollector,
    requesterAgentIdOverride: executionAgentId,
  };
  const pluginToolsOnly = filterToolsByClientCaps(
    includeOpenClawTools || !includePluginTools
      ? []
      : yield {
          pluginTools: {
            options: pluginToolOptions,
            resolvedConfig: options?.config,
          },
        },
    options?.clientCaps,
  );
  // Neither flush arm may regain execution tools outside its persistence projection.
  const ringZeroTools =
    includeOpenClawTools && !isMemoryFlushRun ? getActiveAgentRingZeroTools() : [];
  const toolSearchTools =
    toolSearchControlsEnabled && ringZeroTools.length === 0
      ? createToolSearchTools({
          ...options,
          runtimeConfig: options?.config,
          agentId,
          catalogRef: options?.toolSearchCatalogRef,
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
    catalog: () => ({
      tools: toolsForModelProvider,
      declaredToolAllowlist,
      unavailableCoreToolReason,
    }),
    isAvailable: (): boolean => turnAuthorized({ name: "message" }),
  });
  const assembledTools: AnyAgentTool[] = [
    ...scheduledCoreTools,
    // Include channel-defined agent tools (login, etc.).
    ...(includeChannelTools ? listChannelAgentTools({ cfg: options?.config }) : []),
    ...(includeOpenClawTools
      ? mergeAgentRingZeroTools(
          ringZeroTools,
          yield {
            ...pluginToolOptions,
            sessionPortalTarget,
            sandboxSessionRenameOnly: capabilityProfile.policy.sandboxSessionRenameOnly,
            questionInputMode: capabilityProfile.conversation.questionInputMode,
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
            gatewayCallerAccountId: gatewayCaller.accountId,
            gatewayCallerChannel: gatewayCaller.channel,
            gatewayCallerLocal: gatewayCaller.local,
            gatewayCallerScheduled: gatewayCaller.scheduled,
            admitScheduledMessageInvocation: options?.messageActionTurnCapability
              ? messageInvocationPolicy.admit
              : undefined,
            agentGroupId: options?.groupId ?? null,
            agentGroupChannel: options?.groupChannel ?? null,
            agentGroupSpace: options?.groupSpace ?? null,
            agentMemberRoleIds: options?.memberRoleIds,
            sandboxRoot,
            sandboxAgentId: sandbox?.agentId,
            sandboxContainerWorkdir: sandbox?.containerWorkdir,
            sandboxFsBridge,
            sandboxReadOnlyResourceMounts: sandbox?.readOnlyResourceMounts,
            sandboxWorkspaceMediaReadAllowed,
            spawnWorkspaceDir: capabilityProfile.workspace.spawnWorkspaceRoot,
            // Sandboxes execute against copied roots, but accepted suggestions create host
            // worktrees. Unsandboxed task-repo sessions must stay on their runtime cwd.
            cwd: sandbox
              ? (capabilityProfile.workspace.spawnWorkspaceRoot ?? runtimeRoot)
              : runtimeRoot,
            gatewayConfigReadAllowed: capabilityProfile.policy.gatewayConfigReadAllowed,
            cronCreatorToolAllowlist,
            cronCreatorToolAllowlistCaptureRef: options?.cronCreatorToolAllowlistCaptureRef,
            resolveCronCreatorToolAuthority: cronCreatorAuthorityResolver,
            currentChatType: options?.chatType,
            computerTransport:
              options?.computerTransport === null
                ? null
                : (options?.computerTransport ??
                  resolveSessionPlacementComputer(options?.operationalRunInstance)),
            sourceReplyOnly,
            enableHeartbeatTool,
            offerHeartbeatTool,
            disablePluginTools: !includePluginTools,
            wrapBeforeToolCallHook: false,
            ...(cronSelfRemoveOnlyJobId ? { cronSelfRemoveOnlyJobId } : {}),
            inheritedToolAllowlist,
            inheritedToolDenylist,
            delegatedToolDenyFloor,
            requesterToolDenylist,
            readDelegationConfig: options?.config
              ? createRuntimeConfigReader(options.config)
              : undefined,
            inheritedToolPolicySource: capabilityProfile.policy.inheritedToolPolicySource,
            processScopeKey: scopeKey,
          },
        )
      : pluginToolsOnly),
    ...toolSearchTools,
  ];
  options?.recordToolPrepStage?.("openclaw-tools");
  const tools = preparedTools
    ? [...new Map([...assembledTools, ...preparedTools].map((tool) => [tool.name, tool])).values()]
    : assembledTools;
  if (unavailablePublicationTool) {
    tools.push(unavailablePublicationTool);
  }
  const swarmStructuredOutputTool =
    options?.swarmCollector && options.swarmOutputSchema
      ? tools.find((tool) => tool.name === "structured_output")
      : undefined;
  const toolsForMemoryFlush = projectMemoryFlushTools(
    tools,
    isMemoryFlushRun && memoryFlushWritePath
      ? {
          root: sandboxRoot ?? workspaceRoot,
          relativePath: memoryFlushWritePath,
          memoryWriteProvenance,
          containerWorkdir: sandbox?.containerWorkdir,
          sandbox:
            sandboxRoot && sandboxFsBridge
              ? { root: sandboxRoot, bridge: sandboxFsBridge }
              : undefined,
        }
      : isMemoryFlushRun
        ? options?.memoryFlushTools
        : undefined,
  );
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
    preparedRequesterPolicy: capabilityProfile.policy,
    localModelLeanPreserveToolNames,
  });
  options?.recordToolPrepStage?.("model-provider-policy");
  const declaredToolAllowlist = buildDeclaredToolAllowlistContext({
    config: options?.config,
    metadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    workspaceDir: workspaceRoot,
    toolDenylist: pluginToolDenylist,
  });
  // Host-bound ring-zero tools carry their own authority checks. Agent policy
  // must not deadlock setup, but the tools still receive schema/hook wrappers.
  const completeTurnTools = (filtered: AnyAgentTool[]) =>
    applySwarmCollectorToolContract(
      applyDelegationCapability(
        mergeAgentRingZeroTools(ringZeroTools, filtered),
        options?.delegationCapability,
      ),
      { swarmCollector: options?.swarmCollector, structuredOutputTool: swarmStructuredOutputTool },
    );
  const inheritableTools = completeTurnTools(
    messageInvocationPolicy.filter(capabilityProfile, onPolicyFilter),
  );
  const turnSurface = resolveTurnToolSurface({
    turnTools: inheritableTools,
    sessionTools:
      capabilityProfile.policy.requesterPolicySource === "completion-handoff"
        ? completeTurnTools(messageInvocationPolicy.filter(capabilityProfile, undefined, "session"))
        : undefined,
    ownerOnlyDenied: new Set(ownerOnlyCoreToolDenylist),
    withheld: unavailablePublicationTool,
  });
  const { tools: authorizedTools, turnAuthorized, callableTools, exportedTools } = turnSurface;
  if (options?.inheritedPublicationToolRef) {
    options.inheritedPublicationToolRef.current = inheritableTools.find(
      (tool) => tool === unavailablePublicationTool,
    );
  }
  assertMemoryFlushPersistenceToolAvailable(authorizedTools, options?.memoryFlushTools);
  authorizedTools.forEach(bindAssembledAgentToolActionDescriptor);
  if (shouldInheritEffectiveToolAllowlist) {
    // Snapshot exporter only: this copies policy-approved tools for descendants and
    // never filters the mandatory structured_output tool from this turn.
    replaceWithEffectiveToolAllowlist(inheritedToolAllowlist, exportedTools);
  }
  replaceWithEffectiveCronCreatorToolAllowlist(cronCreatorToolAllowlist, callableTools, (tool) =>
    getPluginToolMeta(tool),
  );
  warnIfMemoryFlushFileWriterUnavailable({
    tools: authorizedTools,
    relativePath: memoryFlushWritePath,
    messageProvider: options?.toolPolicyMessageProvider ?? options?.messageProvider,
  });
  options?.recordToolPrepStage?.("authorization-policy");
  const turnSourceChannel = options?.messageChannel ?? options?.messageProvider;
  const turnSourceTo = options?.currentMessagingTarget ?? options?.currentChannelId;
  const requester = buildHarnessHostRequester(options ?? {});
  const hookContext = {
    awaitSessionDiffBaseline: options?.awaitSessionDiffBaseline,
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
    ...(Object.keys(requester).length > 0 ? { requester } : {}),
    ...(turnSourceChannel ? { turnSourceChannel } : {}),
    ...(turnSourceTo ? { turnSourceTo } : {}),
    ...(options?.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
    ...(options?.currentThreadTs ? { turnSourceThreadId: options.currentThreadTs } : {}),
    ...(options?.trace ? { trace: options.trace } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: options?.config, agentId }),
    onToolOutcome: options?.onToolOutcome,
    allocateToolOutcomeOrdinal: options?.allocateToolOutcomeOrdinal,
  };
  const finalizedTools = finalizeAgentTools({
    ...options,
    tools: filterRequesterYieldTools(authorizedTools, executionSessionKey),
    wrapBeforeToolCallHook: preparedTools
      ? (tool) =>
          options?.wrapBeforeToolCallHook !== false &&
          !preparedTools.some((prepared) => prepared.name === tool.name)
      : options?.wrapBeforeToolCallHook,
    hookContext,
    ...(options?.swarmCollector ? { approvalMode: "deny" as const } : {}),
  });
  return finalizedTools.map(
    createCodingToolsGatewayCaller({
      options,
      agentId: executionAgentId,
      sessionKey: executionSessionKey,
      accountId: gatewayCaller.accountId,
      capabilityProfile,
      tools: finalizedTools,
      sessionEventSourcePolicy: options?.sessionEventSourcePolicy ?? {
        toolsAllow: finalizedTools.filter(turnAuthorized).map((tool) => tool.name),
      },
    }),
  );
}

/** @deprecated Use createOpenClawCodingToolsInternalAsync for runtime construction. */
export function createOpenClawCodingToolsInternal(
  ...args: Parameters<typeof assembleOpenClawCodingTools>
): AnyAgentTool[] {
  return withLegacySessionCapabilityRead(() => {
    const assembly = assembleOpenClawCodingTools(...args);
    let step = assembly.next();
    while (!step.done) {
      step = assembly.next(
        "pluginTools" in step.value
          ? resolveOpenClawPluginToolsForOptions(step.value.pluginTools)
          : createOpenClawTools(step.value),
      );
    }
    return step.value;
  });
}

/** Internal preparation data stays outside the public harness factory options. */
export async function createOpenClawCodingToolsInternalAsync(
  options?: InternalCodingToolsOptions,
  skillReadResources?: SkillSnapshot["resolvedSkills"],
  onPolicyFilter?: (event: ToolPolicyFilterEvent) => void,
  preparedSurface?: { tools: AnyAgentTool[]; policy: ReturnType<typeof prepareCoreToolPolicy> },
  preparation: ToolConstructionPreparationOptions = {},
): Promise<AnyAgentTool[]> {
  return withPreparedToolConstruction(
    options?.config,
    {
      ...preparation,
      signal:
        options?.abortSignal && preparation.signal
          ? AbortSignal.any([options.abortSignal, preparation.signal])
          : (options?.abortSignal ?? preparation.signal),
    },
    async (shared) => {
      const conversationCapabilityProfile =
        options?.conversationCapabilityProfile ??
        (await prepareConversationCapabilityProfile({
          ...options,
          config: shared.config,
          agentId: options?.policyAgentId ?? options?.agentId,
          sandboxToolPolicy: options?.sandbox?.enabled ? options.sandbox.tools : undefined,
          pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
        }));
      const assembly = assembleOpenClawCodingTools(
        { ...options, config: shared.config, conversationCapabilityProfile },
        skillReadResources,
        onPolicyFilter,
        preparedSurface,
      );
      let step = assembly.next();
      while (!step.done) {
        const tools =
          "pluginTools" in step.value
            ? await resolveOpenClawPluginToolsForOptionsAsync(step.value.pluginTools)
            : await createOpenClawToolsWithPreparation(step.value, shared);
        shared.assertCurrent();
        step = assembly.next(tools);
      }
      return step.value;
    },
  );
}

/** @deprecated Use createOpenClawCodingToolsAsync to prepare policy through the worker. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
export function createOpenClawCodingTools(options?: PluginCodingToolsOptions): AnyAgentTool[] {
  warnPluginSdkDeprecation({
    family: "tool-surface",
    method: "createOpenClawCodingTools",
    replacement: "await createOpenClawCodingToolsAsync()",
  });
  return createOpenClawCodingToolsInternal(options);
}

/** Build the SDK tool list with a fresh, source-bound exec policy. */
export function createOpenClawCodingToolsAsync(
  options?: PluginCodingToolsOptions,
): Promise<AnyAgentTool[]> {
  return createOpenClawCodingToolsInternalAsync(options);
}
