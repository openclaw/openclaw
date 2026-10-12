import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { createShowWidgetTool, hasRegisteredShowWidgetKinds } from "../canvas/widget-tool.js";
import { getRuntimeConfig, selectApplicableRuntimeConfig } from "../config/config.js";
import { resolveControlUiSessionLinkBase } from "../config/control-ui-link-base.js";
import { isEmbeddedMode } from "../infra/embedded-mode.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getActiveRuntimeWebToolsMetadataFromState } from "../secrets/runtime-web-tools-state.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import { resolveSkillWorkshopToolConstructionBlock } from "../skills/workshop/tool-availability.js";
import { hasConfiguredWebSearchProvider } from "../web-search/runtime.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
} from "./agent-scope.js";
import { finalizeAgentToolAvailability } from "./agent-tool-availability.js";
import { bindAssembledAgentToolActionDescriptor } from "./agent-tool-metadata.js";
import {
  type HookContext,
  isToolWrappedWithBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "./auth-profiles/store-runtime.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
import { createHostedGatewayTools } from "./openclaw-tools.gateway.js";
import {
  isToolExplicitlyAllowedByFactoryPolicy,
  mergeFactoryPolicyList,
  resolveImageToolFactoryAvailable,
  resolveOptionalMediaToolFactoryPlan,
} from "./openclaw-tools.media-factory-plan.js";
import { prepareOpenClawTools } from "./openclaw-tools.preparation.js";
import {
  applyNodesToolWorkspaceGuard,
  shouldIncludePrimarySessionToolForOpenClawTools,
  shouldIncludeProgressCardToolForOpenClawTools,
} from "./openclaw-tools.registration.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { createOpenClawSwarmToolGroups } from "./openclaw-tools.swarm.js";
import { resolveTranscriptsTool } from "./openclaw-tools.transcripts.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveWidgetPresentationForRun } from "./openclaw-tools.widget-presentation.js";
import {
  withPreparedToolConstruction,
  type PreparedToolConstruction,
  type ToolConstructionPreparationOptions,
} from "./tool-construction-preparation.js";
import { resolveToolLoopDetectionConfig } from "./tool-loop-detection-config.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createComputerTool } from "./tools/computer-tool.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./tools/conversation-tools.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createDashboardTool } from "./tools/dashboard-tool.js";
import { createDecisionTool } from "./tools/decision-tool.js";
import { createEmbeddedCallGateway } from "./tools/embedded-gateway-stub.js";
import { createGatewayToolCallerWrapper } from "./tools/gateway-caller-context.js";
import { createGitHubIdentityStatusTool } from "./tools/github-identity-status-tool.js";
import { createGitHubPublishTool } from "./tools/github-publish-tool.js";
import {
  createCreateGoalTool,
  createGetGoalTool,
  createUpdateGoalTool,
} from "./tools/goal-tools.js";
import { createHeartbeatResponseTool } from "./tools/heartbeat-response-tool.js";
import { createImageGenerateTool } from "./tools/image-generate-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { callAgentToolGatewayRequest } from "./tools/in-process-gateway.js";
import { createInstalledSkillTools } from "./tools/installed-skill-tools.js";
import { createMessageTool, createMessageToolAsync } from "./tools/message-tool-execution.js";
import { createMobileUiTool } from "./tools/mobile-ui-tool.js";
import { createMusicGenerateTool } from "./tools/music-generate-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createPdfTool } from "./tools/pdf-tool.js";
import { createAvailablePortalTools } from "./tools/portal-tool.js";
import { createProgressCardTool } from "./tools/progress-card-tool.js";
import { createScreenTool } from "./tools/screen-tool.js";
import { createSecretsTool } from "./tools/secrets-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSearchTool } from "./tools/sessions-search-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSessionsTool } from "./tools/sessions-tool.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";
import { createConfiguredSkillWorkshopTool } from "./tools/skill-workshop-tool-factory.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTaskSuggestionTools } from "./tools/task-suggestion-tools.js";
import { createTerminalTool } from "./tools/terminal-tool.js";
import { createThemeTool } from "./tools/theme-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createVideoGenerateTool } from "./tools/video-generate-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export { filterToolsByClientCaps } from "./openclaw-tools.client-caps.js";
export async function createOpenClawToolsAsync(
  options?: OpenClawToolsOptions,
  preparation: ToolConstructionPreparationOptions = {},
): Promise<AnyAgentTool[]> {
  return withPreparedToolConstruction(
    options?.config,
    {
      ...preparation,
      assertCurrent: () => {
        preparation.assertCurrent?.();
        options?.assertInvocationCurrent?.();
      },
    },
    (shared) => createOpenClawToolsWithPreparation(options, shared),
  );
}

/** Coding-tool assembly retains this same scope across its construction boundary. */
export async function createOpenClawToolsWithPreparation(
  options: OpenClawToolsOptions | undefined,
  shared: PreparedToolConstruction,
): Promise<AnyAgentTool[]> {
  const { captured, delegated, webSearchConfigured, mediaTools } = await prepareOpenClawTools(
    options,
    shared,
  );
  shared.assertCurrent();
  captured.assertInvocationCurrent?.();
  const steps = createOpenClawToolsSteps(captured, delegated, webSearchConfigured, mediaTools);
  let next = steps.next();
  while (!next.done) {
    const messageTool = await createMessageToolAsync(next.value);
    shared.assertCurrent();
    captured.assertInvocationCurrent?.();
    next = steps.next(messageTool);
  }
  return next.value;
}

/** @deprecated Use createOpenClawToolsAsync for runtime construction. */
export function createOpenClawTools(
  options?: OpenClawToolsOptions,
  preparedDelegateTools?: AnyAgentTool[],
  preparedWebSearchConfigured?: boolean,
): AnyAgentTool[] {
  const captured = { ...options };
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: captured.runSessionKey ?? captured.agentSessionKey,
    config: captured.config,
    agentId: captured.requesterAgentIdOverride,
  });
  captured.authProfileStore ??= ensureAuthProfileStoreWithoutExternalProfiles(
    captured.agentDir ?? resolveAgentDir(captured.config ?? {}, sessionAgentId),
    { allowKeychainPrompt: false },
  );
  const steps = createOpenClawToolsSteps(
    captured,
    preparedDelegateTools,
    preparedWebSearchConfigured,
  );
  let next = steps.next();
  while (!next.done) {
    next = steps.next(createMessageTool(next.value));
  }
  return next.value;
}

function* createOpenClawToolsSteps(
  options?: OpenClawToolsOptions,
  preparedDelegateTools?: AnyAgentTool[],
  preparedWebSearchConfigured?: boolean,
  preparedMediaTools?: Readonly<ReturnType<typeof resolveOptionalMediaToolFactoryPlan>>,
): Generator<Parameters<typeof createMessageTool>[0], AnyAgentTool[], AnyAgentTool> {
  const resolvedConfig = options?.config;
  const sessionConfig = options?.sessionConfigSource === "runtime" ? undefined : resolvedConfig;
  const activeProjectKeys = options?.preparedModelRuntime?.activeProjectKeys ?? [];
  const runtimeSnapshot = getActiveSecretsRuntimeConfigSnapshot();
  const availabilityConfig = selectApplicableRuntimeConfig({
    inputConfig: resolvedConfig,
    runtimeConfig: runtimeSnapshot?.config,
    runtimeSourceConfig: runtimeSnapshot?.sourceConfig,
  });
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  const swarmToolGroups = createOpenClawSwarmToolGroups({
    ...options,
    config: sessionConfig ?? getRuntimeConfig(),
    effectiveRequesterAgentId: sessionAgentId,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const spawnWorkspaceDir = resolveWorkspaceRoot(options?.spawnWorkspaceDir ?? workspaceDir);
  options?.recordToolPrepStage?.("openclaw-tools:session-workspace");
  const widgetPresentation = resolveWidgetPresentationForRun(options);
  const inlineWidgetClientAvailable = options?.clientCaps?.includes("inline-widgets") === true;
  const sessionKey = normalizeOptionalString(options?.runSessionKey ?? options?.agentSessionKey);
  const gatewayCallerAccountId = options?.gatewayCallerAccountId ?? options?.agentAccountId;
  const deliveryContext = {
    channel: options?.agentChannel,
    to: options?.currentChannelId ?? options?.agentTo,
    accountId: options?.agentAccountId,
    threadId: options?.currentThreadTs ?? options?.agentThreadId,
  };
  const runtimeWebTools = getActiveRuntimeWebToolsMetadataFromState();
  const sandbox =
    options?.sandboxRoot && options?.sandboxFsBridge
      ? {
          root: options.sandboxRoot,
          bridge: options.sandboxFsBridge,
          readOnlyResourceMounts: options.sandboxReadOnlyResourceMounts,
          stagedMediaPaths: options.stagedMediaPaths,
        }
      : undefined;
  const optionalMediaTools =
    preparedMediaTools ??
    resolveOptionalMediaToolFactoryPlan({
      config: availabilityConfig ?? resolvedConfig,
      workspaceDir,
      authStore: options?.authProfileStore,
      toolAllowlist: options?.pluginToolAllowlist,
      toolDenylist: options?.pluginToolDenylist,
      preparedModelRuntime: options?.preparedModelRuntime,
    });
  const trimmedRunSessionKey = options?.runSessionKey?.trim();
  const requesterSessionKey = trimmedRunSessionKey || options?.agentSessionKey;
  const mediaGenerationAgentSessionKey =
    trimmedRunSessionKey && isCronRunSessionKey(trimmedRunSessionKey)
      ? trimmedRunSessionKey
      : options?.agentSessionKey;
  const imageTool =
    options?.agentDir &&
    resolveImageToolFactoryAvailable({
      ...options,
      config: availabilityConfig ?? resolvedConfig,
      workspaceDir,
      authStore: options?.authProfileStore,
    })
      ? createImageTool({
          ...options,
          config: availabilityConfig ?? options?.config,
          agentId: sessionAgentId,
          workspaceDir,
          sandbox,
          deferAutoModelResolution: true,
        })
      : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-tool");
  const mediaGenerationToolOptions = {
    ...options,
    agentSessionKey: mediaGenerationAgentSessionKey,
    requesterRunSessionKey: trimmedRunSessionKey,
    requesterAgentId: sessionAgentId,
    requesterOrigin: widgetPresentation.deliveryContext ?? undefined,
    workspaceDir,
    sandbox,
  };
  const imageGenerateTool = optionalMediaTools.imageGenerate
    ? createImageGenerateTool(mediaGenerationToolOptions, preparedMediaTools ? true : undefined)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:image-generate-tool");
  const videoGenerateTool = optionalMediaTools.videoGenerate
    ? createVideoGenerateTool(mediaGenerationToolOptions, preparedMediaTools ? true : undefined)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:video-generate-tool");
  const musicGenerateTool = optionalMediaTools.musicGenerate
    ? createMusicGenerateTool(mediaGenerationToolOptions, preparedMediaTools ? true : undefined)
    : null;
  options?.recordToolPrepStage?.("openclaw-tools:music-generate-tool");
  const pdfTool =
    optionalMediaTools.pdf && options?.agentDir?.trim()
      ? createPdfTool({
          ...options,
          agentId: sessionAgentId,
          workspaceDir,
          sandbox,
          activeModel:
            options?.modelProvider && options.modelId
              ? {
                  provider: options.modelProvider,
                  model: options.modelId,
                  supportsImages: options.modelHasVision === true,
                }
              : undefined,
          deferAutoModelResolution: true,
        })
      : null;
  options?.recordToolPrepStage?.("openclaw-tools:pdf-tool");
  const webSearchAgentDir =
    options?.agentDir ?? resolveAgentDir(resolvedConfig ?? {}, sessionAgentId);
  let webSearchTool = createWebSearchTool({
    ...options,
    agentDir: webSearchAgentDir,
    enabled: options?.webSearchEnabled,
    runtimeWebSearch: runtimeWebTools?.search,
    lateBindRuntimeConfig: true,
  });
  if (webSearchTool) {
    const configured =
      preparedWebSearchConfigured ??
      hasConfiguredWebSearchProvider({
        config: availabilityConfig ?? resolvedConfig,
        agentDir: webSearchAgentDir,
        authStore: options?.authProfileStore,
        runtimeWebSearch: runtimeWebTools?.search,
        ...(options?.authProfileStoreSource !== undefined
          ? { resolveAuthProfileStoreSource: () => options.authProfileStoreSource === true }
          : {}),
      });
    options?.onWebSearchConfiguration?.(configured);
    if (!configured) {
      webSearchTool = null;
    }
  }
  options?.recordToolPrepStage?.("openclaw-tools:web-search-tool");
  const webFetchTool = createWebFetchTool({
    ...options,
    runtimeWebFetch: runtimeWebTools?.fetch,
    lateBindRuntimeConfig: true,
    hostnameAllowlistRef: options?.webFetchHostnameAllowlistRef,
  });
  options?.recordToolPrepStage?.("openclaw-tools:web-fetch-tool");
  const messageTool = options?.disableMessageTool
    ? null
    : yield {
        ...options,
        agentSessionKey: options?.messageToolTurnCapability?.sessionKey ?? options?.agentSessionKey,
        runSessionKey:
          options?.runSessionKey ??
          (options?.messageToolTurnCapability ? options.agentSessionKey : undefined),
        agentId: sessionAgentId,
        messageActionTurnCapability:
          options?.messageToolTurnCapability?.token ?? options?.messageActionTurnCapability,
        admitScheduledInvocation: options?.admitScheduledMessageInvocation,
        preparedMessageToolCatalog: options?.preparedModelRuntime?.messageToolCatalog,
        currentMessagingTarget:
          options?.currentMessagingTarget ??
          (options?.sourceReplyOnly ? options.agentTo : undefined),
        currentChannelProvider: options?.agentChannel,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
        workspaceDir,
      };
  const heartbeatTool = options?.enableHeartbeatTool ? createHeartbeatResponseTool() : null;
  options?.recordToolPrepStage?.("openclaw-tools:message-tool");
  const nodesToolBase = createNodesTool({
    ...options,
    agentId: sessionAgentId,
  });
  const nodesTool = applyNodesToolWorkspaceGuard(nodesToolBase, {
    ...options,
    workspaceDir,
  });
  options?.recordToolPrepStage?.("openclaw-tools:nodes-tool");
  const embedded = isEmbeddedMode();
  const explicitFactoryAllowlist = mergeFactoryPolicyList(
    resolvedConfig?.tools?.allow,
    resolvedConfig?.tools?.alsoAllow,
    options?.pluginToolAllowlist,
  );
  const explicitFactoryDenylist = mergeFactoryPolicyList(
    resolvedConfig?.tools?.deny,
    options?.pluginToolDenylist,
  );
  const scheduledWidgetExplicitlyAllowed = isToolExplicitlyAllowedByFactoryPolicy({
    toolName: "show_widget",
    allowlist: options?.runtimeToolAllowlist,
    denylist: explicitFactoryDenylist,
  });
  // Admitted Control UI recovery and explicitly capped scheduled turns can
  // keep authoring their durable board without claiming an inline renderer.
  const pinnedWidgetOnly =
    (options?.pinnedWidgetAuthoring === true ||
      (options?.gatewayCallerScheduled === true && scheduledWidgetExplicitlyAllowed)) &&
    !inlineWidgetClientAvailable &&
    !widgetPresentation.currentChannelPresenter &&
    Boolean(sessionKey) &&
    !isCronRunSessionKey(sessionKey);
  const includeMessageTool =
    !embedded ||
    options?.sourceReplyDeliveryMode === "message_tool_only" ||
    isToolExplicitlyAllowedByFactoryPolicy({
      toolName: "message",
      allowlist: explicitFactoryAllowlist,
      denylist: explicitFactoryDenylist,
    });
  const sessionLookupToolOptions = {
    agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
    sandboxed: options?.sandboxed,
    config: sessionConfig,
    callGateway: embedded ? createEmbeddedCallGateway() : callAgentToolGatewayRequest,
    sessionLinkBase: resolveControlUiSessionLinkBase(resolvedConfig),
  };
  const progressCardTool = shouldIncludeProgressCardToolForOpenClawTools({
    ...options,
    agentId: sessionAgentId,
  })
    ? createProgressCardTool({
        agentSessionKey: sessionKey,
        agentId: sessionAgentId,
        onPlanSaved: options?.onProgressCardPlanSaved,
      })
    : null;
  const transcriptsTool = resolveTranscriptsTool(resolvedConfig, sessionAgentId, options);
  const tools: AnyAgentTool[] = [
    ...createInstalledSkillTools(options?.installedSkills ?? []),
    createDashboardTool({
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      agentId: sessionAgentId,
    }),
    ...(embedded
      ? []
      : [
          nodesTool,
          createMobileUiTool({ idempotencyScope: options?.runId }),
          options?.modelHasVision === false || options?.computerTransport === null
            ? null
            : createComputerTool({
                ...options,
                transport: options?.computerTransport,
                // The tool combines this run scope with the assistant turn and provider call id.
                idempotencyScope: options?.runId,
                contextEpoch: options?.computerContextEpoch,
              }),
          createCronTool({
            ...options,
            // Use the durable runSessionKey; cleanup-retired policy keys leave cron jobs dangling.
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentId: sessionAgentId,
            agentAccountId: gatewayCallerAccountId,
            currentDeliveryContext: deliveryContext,
            creatorToolAllowlist: options?.cronCreatorToolAllowlist,
            creatorToolAllowlistCaptureRef: options?.cronCreatorToolAllowlistCaptureRef,
            resolveCreatorToolAuthority: options?.resolveCronCreatorToolAuthority,
            creatorAuthorityUnavailableReason: options?.cronCreatorAuthorityUnavailableReason,
            selfRemoveOnlyJobId: options?.cronSelfRemoveOnlyJobId,
          }),
          createSessionsTool({
            ...options,
            stopAllowed: options?.swarmCollector !== true,
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentSessionId: options?.sessionId,
            requesterAgentIdOverride: sessionAgentId,
            config: sessionConfig,
          }),
          createScreenTool({
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentId: sessionAgentId,
          }),
          createThemeTool(),
          ...(options?.sandboxed
            ? []
            : [
                createTerminalTool({
                  ...options,
                  agentId: sessionAgentId,
                  agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
                }),
                ...createAvailablePortalTools(options),
              ]),
        ]),
    ...(!embedded && sessionKey && options?.taskSuggestionDeliveryMode === "gateway"
      ? createTaskSuggestionTools({
          sessionKey,
          agentId: sessionAgentId,
          cwd: resolveWorkspaceRoot(options?.cwd ?? options?.workspaceDir ?? inferredWorkspaceDir),
        })
      : []),
    includeMessageTool ? messageTool : null,
    !isCoreCanvasHostEnabled(resolvedConfig) &&
    !hasRegisteredShowWidgetKinds() &&
    !widgetPresentation.currentChannelPresenter
      ? null
      : createShowWidgetTool({
          sessionId: options?.sessionId,
          agentId: sessionAgentId,
          agentSessionKey: sessionKey,
          inlineHostEnabled: isCoreCanvasHostEnabled(resolvedConfig),
          inlineClientAvailable: inlineWidgetClientAvailable,
          pinnedOnly: pinnedWidgetOnly,
          presenters: widgetPresentation.presenters,
          presenterContext: widgetPresentation.context,
        }),
    heartbeatTool,
    createDecisionTool(sessionAgentId, options),
    createTtsTool({ ...options, agentId: sessionAgentId }),
    options?.githubPublicationAvailable !== undefined ? createGitHubIdentityStatusTool() : null,
    options?.githubPublicationAvailable === true ? createGitHubPublishTool() : null,
    transcriptsTool,
    imageGenerateTool,
    musicGenerateTool,
    videoGenerateTool,
    ...createHostedGatewayTools(embedded, sessionAgentId, options, preparedDelegateTools),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: sessionAgentId,
    }),
    ...[createGetGoalTool, createCreateGoalTool, createUpdateGoalTool].map((createTool) =>
      createTool({ ...options, sessionAgentId }),
    ),
    resolveSkillWorkshopToolConstructionBlock({
      sandboxed: options?.sandboxed,
      libraryAuthoring: options?.skillWorkshop?.libraryAuthoring,
    }) || !resolvedConfig
      ? null
      : createConfiguredSkillWorkshopTool({
          config: resolvedConfig,
          agentId: sessionAgentId,
          sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
          runId: options?.runId,
          run: options?.skillWorkshop,
        }),
    progressCardTool,
    ...swarmToolGroups.structuredOutput,
    ...(
      [
        ["ask_user", createAskUserTool],
        ["secrets", createSecretsTool],
      ] as const
    ).map(([name, createTool]) =>
      shouldIncludePrimarySessionToolForOpenClawTools(name, {
        ...options,
        agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      })
        ? createTool({
            ...options,
            agentId: sessionAgentId,
            sessionKey: options?.runSessionKey ?? options?.agentSessionKey,
          })
        : null,
    ),
    createSessionsListTool({
      ...sessionLookupToolOptions,
      requesterAgentIdOverride: sessionAgentId,
      requesterProfileId: options?.gatewayUiCommandTarget?.profileId,
      supportsActiveOnly: !embedded,
      requireSessionReadOwner: embedded,
    }),
    createSessionsHistoryTool({
      ...sessionLookupToolOptions,
      requesterAgentIdOverride: sessionAgentId,
      sessionReadScopeKey: options?.sessionReadScopeKey,
    }),
    createSessionsSearchTool({
      ...sessionLookupToolOptions,
      agentId: sessionAgentId,
      sessionReadScopeKey: options?.sessionReadScopeKey,
    }),
    ...(embedded
      ? []
      : [
          ...[
            createConversationsListTool,
            createConversationsSendTool,
            createConversationsTurnTool,
          ].map((createTool) =>
            createTool({
              ...options,
              agentId: sessionAgentId,
              agentSessionId: options?.sessionId,
            }),
          ),
          // Keep the in-process caller so materialized agent roots retain their creation stamp.
          createSessionsSendTool({
            ...options,
            requesterTurnRunId: options?.runId,
            agentId: sessionAgentId,
            // Match sessions_spawn: spawned children record the durable run
            // session as spawnedBy, so the parent check must use the same key.
            agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
            agentSessionId: options?.sessionId,
            requesterOrigin: {
              channel: options?.agentChannel,
              accountId: options?.agentAccountId,
              to: options?.currentMessagingTarget ?? options?.currentChannelId ?? options?.agentTo,
              threadId: options?.currentThreadTs ?? options?.agentThreadId,
            },
            config: sessionConfig,
          }),
        ]),
    !embedded || options?.allowGatewaySubagentBinding === true
      ? createSessionsSpawnTool({
          ...options,
          // Only a keyed parent has a stored incarnation for spawn to check.
          expectedParentSessionId:
            (options?.runSessionKey ?? options?.agentSessionKey) ? options?.sessionId : undefined,
          agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
          requesterTurnRunId: options?.runId,
          completionOwnerKey: options?.runSessionKey,
          currentMessagingTarget: options?.currentMessagingTarget ?? options?.currentChannelId,
          currentChannelId: options?.nativeChannelId ?? options?.currentChannelId,
          // A host-derived native channel id or an embedded/HTTP turn (no loopback
          // provenance) is trusted; only caller-writable generic-token headers are not.
          currentConversationOrigin: options?.nativeChannelId
            ? "run-bound-grant"
            : (options?.currentConversationOrigin ?? "run-bound-grant"),
          currentThreadTs: options?.currentThreadTs,
          config: sessionConfig,
          requesterAgentIdOverride: sessionAgentId,
          requesterRunId: options?.runId,
          workspaceDir: spawnWorkspaceDir,
        })
      : null,
    ...swarmToolGroups.agentsWait,
    createSessionsYieldTool({
      ...options,
      claimYield: createRequesterYieldCallback({
        ...options,
        requesterSessionKey,
        requesterAgentId: sessionAgentId,
        requesterTurnRunId: options?.runId,
      }),
    }),
    createSubagentsTool({
      // Match the durable controller key the spawn tool registers runs under, so split-key
      // callers (e.g. Telegram DM with a policy key distinct from the durable run key) still
      // see their spawned runs in the active/recent list. Mirrors createSessionsSpawnTool above.
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      // Retained task rows created before the durable-key alignment still carry the policy
      // key in owner_key; let the listing/cancel tool match both so those rows stay reachable
      // for split-key callers instead of disappearing with "Task outside session tree".
      callerPolicySessionKey: options?.agentSessionKey,
      agentId: sessionAgentId,
      config: sessionConfig,
    }),
    createSessionStatusTool({
      ...options,
      requesterAgentIdOverride: sessionAgentId,
      config: sessionConfig,
      activeModelProvider: options?.modelProvider,
      activeModelId: options?.modelId,
      metadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
      activeDeliveryContext: deliveryContext,
    }),
    webSearchTool,
    webFetchTool,
    imageTool,
    pdfTool,
  ].filter((tool): tool is AnyAgentTool => tool !== null && tool !== undefined);
  options?.recordToolPrepStage?.("openclaw-tools:core-tool-list");
  let allTools = tools;
  if (!options?.disablePluginTools) {
    allTools = [
      ...tools,
      ...resolveOpenClawPluginToolsForOptions({
        options: { ...options, activeProjectKeys },
        resolvedConfig,
        existingToolNames: new Set(tools.map((tool) => tool.name)),
      }),
    ];
    options?.recordToolPrepStage?.("openclaw-tools:plugin-tools");
  }

  allTools = finalizeAgentToolAvailability(filterToolsByClientCaps(allTools, options?.clientCaps));
  options?.recordToolPrepStage?.("openclaw-tools:client-capabilities");
  for (const tool of allTools) {
    bindAssembledAgentToolActionDescriptor(tool);
  }

  const hookAgentId = options?.requesterAgentIdOverride ?? sessionAgentId;
  const wrapGatewayCallerIdentity = createGatewayToolCallerWrapper(
    hookAgentId,
    options ? { ...options, agentAccountId: gatewayCallerAccountId } : options,
  );

  if (options?.wrapBeforeToolCallHook === false) {
    return allTools.map(wrapGatewayCallerIdentity);
  }
  const defaultHookContext: HookContext = {
    ...(hookAgentId ? { agentId: hookAgentId } : {}),
    ...(resolvedConfig ? { config: resolvedConfig } : {}),
    ...(options?.agentSessionKey ? { sessionKey: options.agentSessionKey } : {}),
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options?.currentChannelId ? { channelId: options.currentChannelId } : {}),
    loopDetection: resolveToolLoopDetectionConfig({ cfg: resolvedConfig, agentId: hookAgentId }),
  };
  const hookContext = { ...defaultHookContext, ...options?.beforeToolCallHookContext };
  options?.recordToolPrepStage?.("openclaw-tools:tool-hooks");
  return allTools
    .map((tool) =>
      isToolWrappedWithBeforeToolCallHook(tool)
        ? tool
        : wrapToolWithBeforeToolCallHook(tool, hookContext),
    )
    .map(wrapGatewayCallerIdentity);
}
