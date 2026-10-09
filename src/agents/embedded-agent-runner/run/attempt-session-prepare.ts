import { isAnthropicOAuthApiKey, isDirectAnthropicModel } from "@openclaw/ai/internal/anthropic";
import { supportsClaudeInHistorySystemMessages } from "@openclaw/llm-core";
import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import {
  attachRuntimePromptMediaFacts,
  readPersistedMediaFacts,
} from "../../../media/media-facts.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  isMainSessionRestartRecoveryInputProvenance,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
} from "../../../sessions/input-provenance.js";
import type { PersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.types.js";
import { createPreparedEmbeddedAgentSettingsManager } from "../../agent-project-settings.js";
import {
  applyAgentAutoCompactionGuard,
  isSilentOverflowProneModel,
  resolveEffectiveCompactionMode,
} from "../../agent-settings.js";
import { toToolDefinitions } from "../../agent-tool-definition-adapter.js";
import { sanitizeCompactionReplayMessages } from "../../compaction-replay.js";
import { resolveUserTimezone } from "../../date-time.js";
import { bootstrapHarnessContextEngine } from "../../harness/context-engine-lifecycle.js";
import { relocateCurrentRuntimeContextCarrierToTail } from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  type AgentSession,
  type CreateAgentSessionOptions,
  SessionManager,
} from "../../sessions/index.js";
import { DefaultResourceLoader } from "../../sessions/resource-loader.js";
import { createAgentSession } from "../../sessions/sdk.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { resolveToolSearchCatalogTool } from "../../tool-search.js";
import { runContextEngineMaintenance } from "../context-engine-maintenance.js";
import { buildEmbeddedExtensionFactories } from "../extensions.js";
import { log } from "../logger.js";
import { declarePromptHistoryRewrite } from "../prompt-cache-observability.js";
import { recordRuntimeContextProjection } from "../session-prompt-state.js";
import { resolveEmbeddedAgentApiKey } from "../stream-resolution.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { createAttemptCompactionThinkingResolver } from "./attempt-compaction-thinking.js";
import { resolveAttemptTranscriptPolicy } from "./attempt-history.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import {
  replayTrailingEntriesForOrphanRepair,
  resolveOrphanRepairPlan,
} from "./attempt-orphan-repair.js";
import {
  installAttemptPermissionPrompt,
  type SystemPromptUpdatePreparation,
} from "./attempt-permission-prompt.js";
import { buildAfterTurnRuntimeContext } from "./attempt-prompt-helpers.js";
import { resolveExistingAttemptTranscriptState } from "./attempt-transcript-helpers.js";
import type { EmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";
import {
  installMessageToolOnlyTerminalHook,
  installToolAuthoredSourceReplyTerminalHook,
} from "./message-tool-terminal.js";
import {
  type InitialUserTurnReplayPreparation,
  preparePersistedCurrentUserTurn,
  reconcilePrePersistedCurrentUserTurn,
} from "./pre-persisted-user-turn.js";
import {
  applyRuntimeContextCarrierRetention,
  setSteeringRuntimeContextRetention,
} from "./runtime-context-prompt.js";
import { resolveSessionBoundaryPromptCacheKey } from "./session-boundary-prompt-cache-key.js";
import { resolveEmbeddedSessionContextLimits } from "./session-context-limits.js";
import { withEmbeddedAttemptToolActivity } from "./tool-activity-heartbeat.js";
import {
  createToolLoopBatchAdmission,
  installToolLoopRecoveryCleanup,
} from "./tool-loop-recovery.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type ClientToolPreparation = Omit<
  Parameters<typeof prepareEmbeddedAttemptClientTools>[0],
  "attempt"
>;

type AttemptSessionManager = ReturnType<typeof guardSessionManager>;

export async function prepareEmbeddedAttemptAgentSession(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngineInfo?: ContextEngine["info"];
  agentCoreThinkingLevel: CreateAgentSessionOptions["thinkingLevel"];
  agentDir: string;
  clientToolPreparation: ClientToolPreparation;
  effectiveCwd: string;
  getCurrentAttemptPluginMetadataSnapshot: () => PluginMetadataSnapshot | undefined;
  initialSystemPrompt: string;
  markStage: (stage: string) => void;
  onSessionCreated: (session: AgentSession) => void;
  onSystemPromptChanged: (systemPrompt: string) => void;
  runAbortSignal: AbortSignal;
  sessionAgentId: string;
  transcriptLifecycle: EmbeddedAttemptTranscriptLifecycle;
  sessionManager: AttemptSessionManager;
  prepareInitialUserTurnReplay?: InitialUserTurnReplayPreparation;
  prepareSystemPromptUpdate?: SystemPromptUpdatePreparation;
}) {
  const { attempt, prepareSystemPromptUpdate } = input;
  const settingsManager = createPreparedEmbeddedAgentSettingsManager({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    cfg: attempt.config,
    pluginMetadataSnapshot: input.getCurrentAttemptPluginMetadataSnapshot(),
    contextTokenBudget: attempt.contextTokenBudget,
  });
  applyAgentAutoCompactionGuard({
    settingsManager,
    contextEngineInfo: input.activeContextEngineInfo,
    compactionMode: resolveEffectiveCompactionMode(attempt.config),
    silentOverflowProneProvider: isSilentOverflowProneModel({
      provider: attempt.provider,
      modelId: attempt.modelId,
      baseUrl: attempt.model.baseUrl ?? undefined,
    }),
    // The finalizer's result gate rejects any compaction, so never start one.
    compactionForbidden: attempt.operation === "settled-tool-finalization",
  });

  // These factories carry compaction/pruning runtime state into the resource loader.
  const extensionFactories = buildEmbeddedExtensionFactories({
    cfg: attempt.config,
    sessionManager: input.sessionManager,
    provider: attempt.provider,
    modelId: attempt.modelId,
    model: attempt.model,
    contextTokenBudget: attempt.contextTokenBudget,
    agentId: input.sessionAgentId,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey ?? attempt.sandboxSessionKey,
    runId: attempt.runId,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.effectiveCwd,
    agentDir: input.agentDir,
    extensionFactories,
  });
  await resourceLoader.reload();
  input.markStage("session-resource-loader");

  // Tool creation needs the same runner later used by lifecycle hooks.
  const hookRunner = getGlobalHookRunner();
  const preparedClientTools = prepareEmbeddedAttemptClientTools({
    attempt,
    ...input.clientToolPreparation,
  });
  const { allCustomTools, sessionToolAllowlist, ...clientToolRuntime } = preparedClientTools;

  const { session: activeSession } = await createAgentSession({
    systemPrompt: input.initialSystemPrompt,
    cwd: input.effectiveCwd,
    modelRegistry: attempt.modelRegistry,
    model: attempt.model,
    thinkingLevel: input.agentCoreThinkingLevel,
    tools: sessionToolAllowlist,
    customTools: allCustomTools,
    sessionManager: input.sessionManager,
    settingsManager,
    resourceLoader,
    resolveDeferredTool: input.clientToolPreparation.deferredDirectoryToolsCallable
      ? ({ toolCall }) => {
          const toolAbortSignal =
            input.clientToolPreparation.getToolAbortSignal?.() ?? input.runAbortSignal;
          const tool = resolveToolSearchCatalogTool(
            {
              config: attempt.config,
              runtimeConfig: attempt.config,
              agentId: input.sessionAgentId,
              sessionKey: input.clientToolPreparation.sandboxSessionKey,
              sessionId: attempt.sessionId,
              runId: attempt.runId,
              catalogRef: input.clientToolPreparation.toolSearchCatalogRef,
              abortSignal: toolAbortSignal,
            },
            toolCall.name,
          );
          // Catalog entries own hooks; the adapter must carry the captured
          // generation into them so approvals cannot outlive a permission change.
          const definition = tool
            ? toToolDefinitions(
                [tool],
                input.clientToolPreparation.catalogToolHookContext,
                toolAbortSignal,
              )[0]
            : undefined;
          const hydratedTool = definition ? wrapToolDefinition(definition) : undefined;
          if (hydratedTool) {
            log.info(`tool-search: hydrated deferred directory tool ${toolCall.name}`);
            const originalExecute = hydratedTool.execute;
            hydratedTool.execute = (...args: Parameters<typeof originalExecute>) =>
              withEmbeddedAttemptToolActivity(attempt.runId, () => originalExecute(...args));
          }
          return hydratedTool;
        }
      : undefined,
    withSessionWriteSettlement: (operation) =>
      input.transcriptLifecycle.withTranscriptWrite(operation),
    cleanupProviderSessionResourcesOnDispose: false,
    // Without a resolved model budget, the outer loop cannot own bounded recovery.
    contextOverflowRecoveryOwner: attempt.contextTokenBudget === undefined ? "session" : "caller",
    resolveCompactionThinkingLevel: createAttemptCompactionThinkingResolver(
      attempt,
      input.sessionAgentId,
    ),
    beforeToolBatch: input.clientToolPreparation.catalogToolHookContext
      ? createToolLoopBatchAdmission(input.clientToolPreparation.catalogToolHookContext)
      : undefined,
  });
  // Publish ownership before post-construction hooks. Outer cleanup must dispose
  // the session if tool activation or terminal-hook installation fails.
  input.onSessionCreated(activeSession);
  installToolLoopRecoveryCleanup({ agent: activeSession.agent, runId: attempt.runId });
  activeSession.setActiveToolsByName(sessionToolAllowlist);
  const setActiveSessionSystemPrompt = (nextSystemPrompt: string) => {
    input.onSystemPromptChanged(nextSystemPrompt);
    activeSession.setBaseSystemPrompt(nextSystemPrompt.trim());
    return nextSystemPrompt;
  };
  const setPermissionPromptPreparation = installAttemptPermissionPrompt({
    activeSession,
    attempt,
    runAbortSignal: input.runAbortSignal,
    setActiveSessionSystemPrompt,
    prepareInitialUserTurnReplay: input.prepareInitialUserTurnReplay,
    prepareSystemPromptUpdate,
  });
  setActiveSessionSystemPrompt(input.initialSystemPrompt);
  let didDeliverSourceReplyViaMessageTool = false;
  const markSourceReplyDelivered = () => {
    didDeliverSourceReplyViaMessageTool = true;
  };
  installMessageToolOnlyTerminalHook({
    agent: activeSession.agent,
    sourceReplyDeliveryMode: attempt.sourceReplyDeliveryMode,
    onDeliveredSourceReply: markSourceReplyDelivered,
    config: attempt.config,
    currentProvider: attempt.messageChannel ?? attempt.messageProvider,
    currentAccountId: attempt.agentAccountId,
    currentChannelId: attempt.currentChannelId,
    currentMessagingTarget: attempt.currentMessagingTarget,
    currentThreadId: attempt.currentThreadTs,
    currentMessageId: attempt.currentMessageId,
    replyToMode: attempt.replyToMode,
    hasRepliedRef: attempt.hasRepliedRef,
    sessionKey: attempt.sessionKey,
  });
  installToolAuthoredSourceReplyTerminalHook({
    agent: activeSession.agent,
    sourceReplyCapableToolNames: clientToolRuntime.sourceReplyCapableToolNames,
  });
  input.markStage("agent-session");

  return {
    activeSession,
    allCustomTools,
    ...clientToolRuntime,
    hasDeliveredSourceReply: () => didDeliverSourceReplyViaMessageTool,
    hookRunner,
    markSourceReplyDelivered,
    setActiveSessionSystemPrompt,
    settingsManager,
    refreshTools: () => {
      const currentPrompt = activeSession.agent.state.systemPrompt;
      preparedClientTools.refreshTools();
      activeSession.replaceCustomTools(allCustomTools, sessionToolAllowlist);
      setActiveSessionSystemPrompt(currentPrompt);
    },
    setPermissionPromptPreparation,
  };
}

type SessionBoundaryAttempt = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "inputProvenance"
  | "onUserMessagePersistenceInvalidated"
  | "operation"
  | "prompt"
  | "promptCacheKey"
  | "sessionId"
  | "sessionKey"
  | "skipPreparedUserTurnMessage"
  | "suppressNextUserMessagePersistence"
  | "userTurnTranscriptRecorder"
>;

type LlmBoundaryOptions = NonNullable<Parameters<typeof normalizeMessagesForLlmBoundary>[1]>;

type CurrentUserTimestampOverride = NonNullable<LlmBoundaryOptions["currentUserTimestampOverride"]>;

export async function prepareEmbeddedAttemptSessionBoundary(input: {
  abortSignal?: AbortSignal;
  activeSession: Pick<AgentSession, "agent">;
  appendOnlyRuntimeContext?: boolean;
  inHistorySystemUpdates?: boolean;
  attempt: SessionBoundaryAttempt;
  getUserTranscriptContexts: () => LlmBoundaryOptions["userTranscriptContexts"];
  isRawModelRun: boolean;
  preparedUserTurnMessage: PersistedUserTurnMessage | undefined;
  sessionManager: ReturnType<typeof guardSessionManager>;
  setActiveSessionSystemPrompt: (systemPrompt: string) => void;
}): Promise<{
  boundaryTimezone: string | undefined;
  includeBoundaryTimestamp: boolean;
  orphanRepair: ReturnType<typeof resolveOrphanRepairPlan>;
  setCurrentUserTimestampOverride: (override: CurrentUserTimestampOverride | undefined) => void;
}> {
  const { activeSession, attempt, isRawModelRun, sessionManager } = input;
  setSteeringRuntimeContextRetention(activeSession, input.appendOnlyRuntimeContext === true);
  const preserveExactPrompt = isRawModelRun || attempt.operation === "settled-tool-finalization";
  if (isRawModelRun) {
    // Raw probes measure only the requested provider prompt. Restored history,
    // queued work, and the normal system prompt would contaminate it.
    activeSession.agent.reset();
    input.setActiveSessionSystemPrompt("");
  }

  let repairedTarget: ReturnType<typeof sessionManager.getSessionTarget>;
  const orphanRepair = preserveExactPrompt
    ? undefined
    : await withSessionManagerWrite(sessionManager, async () => {
        // Speech can advance the transcript while this repair waits for write admission.
        await sessionManager.reloadPersistedTranscriptAsync(input.abortSignal);
        input.abortSignal?.throwIfAborted();
        const candidate = resolveOrphanRepairPlan({
          sessionManager,
          prompt: attempt.prompt,
          preserveLeaf:
            attempt.skipPreparedUserTurnMessage === true ||
            isMainSessionRestartRecoveryInputProvenance(attempt.inputProvenance),
        });
        // Prefer the recorder-owned row; internal retries fold it into model-only context.
        const currentUserTurnMessage = attempt.skipPreparedUserTurnMessage
          ? undefined
          : (attempt.userTurnTranscriptRecorder?.getPersistedMessage?.() ??
            input.preparedUserTurnMessage);
        const reconciledCurrentUser = reconcilePrePersistedCurrentUserTurn({
          activeSession,
          currentUserTurnMessage,
          durableUserTurnMessage: candidate?.messageEntry.message,
          userTurnAlreadyPersisted: attempt.userTurnTranscriptRecorder?.hasPersisted() === true,
        });
        const orphanProvenance = normalizeInputProvenance(
          candidate?.messageEntry.message.provenance,
        );
        // Keep unanswered user input in history through failed internal continuations.
        const preserveUnansweredUser =
          shouldPreserveUserFacingSessionStateForInputProvenance(attempt.inputProvenance) &&
          (!orphanProvenance || orphanProvenance.kind === "external_user");
        if (reconciledCurrentUser || preserveUnansweredUser) {
          return undefined;
        }
        if (candidate?.removeLeaf) {
          if (candidate.messageEntry.parentId) {
            await sessionManager.branchAsync(candidate.messageEntry.parentId);
          } else {
            await sessionManager.resetLeafAsync();
          }
          repairedTarget = sessionManager.getSessionTarget();
          if (repairedTarget) {
            // Persist the cursor even without metadata; settle its projection before the next append.
            await sessionManager.appendLeafControlAsync({
              targetId: sessionManager.getLeafId(),
              appendParentId: sessionManager.getAppendParentId(),
            });
          }
          await replayTrailingEntriesForOrphanRepair(sessionManager, candidate.trailingEntries);
        }
        return candidate;
      });
  if (orphanRepair?.removeLeaf) {
    if (repairedTarget) {
      const { waitForSessionTranscriptProjection } =
        await import("../../../config/sessions/session-transcript-reconcile.js");
      await waitForSessionTranscriptProjection(repairedTarget, input.abortSignal);
      input.abortSignal?.throwIfAborted();
    }
    // The merged replacement prompt needs a new canonical user row.
    sessionManager.clearNextUserMessagePersistenceSuppression?.();
    attempt.onUserMessagePersistenceInvalidated?.();
  }
  if (orphanRepair) {
    const repairedMessages = sanitizeCompactionReplayMessages(
      sessionManager.buildSessionContext().messages,
    );
    // A preserved orphan is the final message in this canonical context. Keep
    // it durable, but omit it from this provider call because prompt assembly includes it.
    activeSession.agent.state.messages = orphanRepair.removeLeaf
      ? repairedMessages
      : repairedMessages.slice(0, -1);
  }

  // This is the single timestamping source for user messages sent to the LLM.
  // Raw probes retain exact prompt bytes.
  const boundaryTimezone = preserveExactPrompt
    ? undefined
    : resolveUserTimezone(attempt.config?.agents?.defaults?.userTimezone);
  let currentUserTimestampOverride: CurrentUserTimestampOverride | undefined;
  const buildBoundaryOptions = (): LlmBoundaryOptions => {
    if (preserveExactPrompt) {
      return {
        appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
        inHistorySystemUpdates: input.inHistorySystemUpdates,
        projectPersistedSenderContext: false,
      };
    }
    const userTranscriptContexts = input.getUserTranscriptContexts();
    return {
      sessionVersion: sessionManager.getHeader()?.version,
      appendOnlyRuntimeContext: input.appendOnlyRuntimeContext,
      inHistorySystemUpdates: input.inHistorySystemUpdates,
      ...(boundaryTimezone ? { timezone: boundaryTimezone } : {}),
      ...(userTranscriptContexts?.length ? { userTranscriptContexts } : {}),
      ...(currentUserTimestampOverride ? { currentUserTimestampOverride } : {}),
    };
  };

  const baseConvertToLlm = activeSession.agent.convertToLlm.bind(activeSession.agent);
  activeSession.agent.convertToLlm = async (messages) => {
    let removedRuntimeContext: AgentMessage[] | undefined;
    const normalized = normalizeMessagesForLlmBoundary(messages, {
      ...buildBoundaryOptions(),
      onRuntimeContextCarrierRemoved: (removed) => {
        removedRuntimeContext = removed;
      },
    });
    const converted = await baseConvertToLlm(
      // Persisted carriers stay after their user turn, including during tool loops;
      // moving one would change the prefix bound to later thinking signatures.
      input.appendOnlyRuntimeContext
        ? normalized
        : relocateCurrentRuntimeContextCarrierToTail(normalized),
    );
    applyRuntimeContextCarrierRetention(converted, input.appendOnlyRuntimeContext);
    if (
      !input.appendOnlyRuntimeContext &&
      recordRuntimeContextProjection(attempt.sessionId, removedRuntimeContext, converted)
    ) {
      declarePromptHistoryRewrite({ ...attempt, reason: "runtimeContextCarrier" });
    }
    return converted;
  };

  return {
    boundaryTimezone,
    includeBoundaryTimestamp: !preserveExactPrompt,
    orphanRepair,
    setCurrentUserTimestampOverride: (override) => {
      currentUserTimestampOverride = override;
    },
  };
}

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;
export async function prepareEmbeddedAttemptSessionManager(input: {
  attempt: EmbeddedRunAttemptParams;
  activeContextEngine?: ContextEngine;
  agentDir: string;
  effectiveCwd: string;
  effectiveWorkspace: string;
  onSessionManagerCreated: (sessionManager: AttemptSessionManager) => void;
  replayAllowedToolNames: ReadonlySet<string>;
  resolveActiveContextEnginePluginId: () => string | undefined;
  sessionAgentId: string;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}) {
  const { attempt } = input;
  const transcriptState = await resolveExistingAttemptTranscriptState({
    sessionManager: attempt.sessionManager,
    agentId: input.sessionAgentId,
    config: attempt.config,
    sessionFile: attempt.sessionFile,
    sessionId: attempt.sessionId,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionTarget,
  });
  const apiKey =
    attempt.model.api === "anthropic-messages" &&
    isDirectAnthropicModel(attempt.model) &&
    supportsClaudeInHistorySystemMessages(attempt.model)
      ? await resolveEmbeddedAgentApiKey(attempt)
      : undefined;
  const transcriptPolicy = resolveAttemptTranscriptPolicy({
    runtimePlan: attempt.runtimePlan,
    runtimePlanModelContext: {
      workspaceDir: input.effectiveWorkspace,
      modelApi: attempt.model.api,
      model: attempt.model,
      directApiKey: Boolean(apiKey) && !isAnthropicOAuthApiKey(apiKey),
    },
    provider: attempt.provider,
    modelId: attempt.modelId,
    config: attempt.config,
    env: process.env,
  });
  const isOpenAIResponsesApi =
    attempt.model.api === "openai-responses" ||
    attempt.model.api === "azure-openai-responses" ||
    attempt.model.api === "openai-chatgpt-responses";

  const preparedUserTurnMessage = attempt.skipPreparedUserTurnMessage
    ? undefined
    : await attempt.userTurnTranscriptRecorder?.resolveMessage();
  let latestPersistedUserMessage: AgentMessage | undefined;
  let latestRuntimeUserMessage: AgentMessage | undefined;
  let latestUserTurnTranscriptRecorder = attempt.userTurnTranscriptRecorder;
  const userTranscriptContextRegistry = createUserTranscriptContextRegistry();
  const unguardedSessionManager =
    attempt.sessionManager ??
    (attempt.sessionTarget
      ? await input.withOwnedTranscriptWrite(() =>
          SessionManager.openAsync(
            attempt.sessionTarget as SessionTranscriptRuntimeTarget,
            input.effectiveCwd,
            resolveEmbeddedSessionContextLimits(attempt.contextTokenBudget),
            attempt.abortSignal,
          ),
        )
      : SessionManager.inMemory(input.effectiveCwd));
  // Publish ownership before awaiting preparation; outer cleanup must receive
  // this same manager even when replay validation or bootstrap fails.
  input.onSessionManagerCreated(unguardedSessionManager);
  const preparedReplay = await input.withOwnedTranscriptWrite(() =>
    preparePersistedCurrentUserTurn({
      sessionManager: unguardedSessionManager,
      message: preparedUserTurnMessage,
      recorder: attempt.userTurnTranscriptRecorder,
      runId: attempt.runId,
      signal: attempt.abortSignal,
    }),
  );
  const prepareInitialUserTurnReplay: InitialUserTurnReplayPreparation | undefined =
    preparedReplay &&
    (async (signal) => {
      const consume = await input.withOwnedTranscriptWrite(() => preparedReplay(signal));
      return consume && ((onAdmitted) => input.withOwnedTranscriptWrite(() => consume(onAdmitted)));
    });
  const sessionManager = guardSessionManager(unguardedSessionManager, {
    agentId: input.sessionAgentId,
    runId: attempt.runId,
    sessionKey: attempt.sessionKey,
    config: attempt.config,
    contextWindowTokens: attempt.contextTokenBudget,
    inputProvenance: attempt.inputProvenance,
    preparedUserTurnMessage,
    preparedUserTurnTranscriptRecorder: preparedUserTurnMessage
      ? attempt.userTurnTranscriptRecorder
      : undefined,
    allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
    missingToolResultText: isOpenAIResponsesApi ? "aborted" : undefined,
    allowedToolNames: input.replayAllowedToolNames,
    trigger: attempt.trigger,
    suppressNextUserMessagePersistence:
      prepareInitialUserTurnReplay !== undefined || attempt.suppressNextUserMessagePersistence,
    suppressTranscriptOnlyAssistantPersistence: attempt.suppressTranscriptOnlyAssistantPersistence,
    assistantErrorTranscript: attempt.assistantErrorTranscript,
    skipBeforeMessageWriteHooks: attempt.operation === "settled-tool-finalization",
    prepareAssistantTranscriptMessage: attempt.prepareAssistantTranscriptMessage,
    onUserMessagePreparingForPersistence: (_message, recorder) => {
      latestPersistedUserMessage = undefined;
      latestUserTurnTranscriptRecorder = recorder;
    },
    onUserMessagePersisted: (message, runtimeMessage) => {
      latestPersistedUserMessage = message;
      latestRuntimeUserMessage = runtimeMessage;
      if (runtimeMessage) {
        const media = readPersistedMediaFacts(message);
        if (media?.length) {
          attachRuntimePromptMediaFacts(runtimeMessage, media);
        }
        userTranscriptContextRegistry.record(runtimeMessage, message);
      }
      attempt.onUserMessagePersisted?.(message);
    },
    onUserMessagePersistenceSuppressed: (message, runtimeMessage) => {
      latestRuntimeUserMessage = runtimeMessage;
      const media = runtimeMessage ? readPersistedMediaFacts(message) : undefined;
      if (runtimeMessage && media?.length) {
        attachRuntimePromptMediaFacts(runtimeMessage, media);
      }
      // Replay suppresses the append of a user that is already durable. Report it
      // like an adopted append so retries and fallbacks do not append it again;
      // after compaction that append would adopt a row outside the current turn.
      if (
        prepareInitialUserTurnReplay !== undefined &&
        !attempt.suppressNextUserMessagePersistence &&
        attempt.userTurnTranscriptRecorder?.hasPersisted() === true
      ) {
        attempt.onUserMessagePersisted?.(message);
      }
    },
    onUserMessageBlocked: () => {
      attempt.userTurnTranscriptRecorder?.markBlocked();
    },
  });
  attempt.promptCacheKey = resolveSessionBoundaryPromptCacheKey({
    api: attempt.model.api,
    boundaryCount: sessionManager.getBoundaryCount(),
    promptCacheKey: attempt.promptCacheKey,
    // A detached helper routes under its private identity but reads the caller's prompt bytes.
    sessionId:
      attempt.sessionPersistence === "detached" &&
      attempt.sessionManager &&
      !attempt.sessionManager.getSessionTarget()
        ? attempt.sessionManager.getSessionId()
        : attempt.sessionId,
  });

  await input.withOwnedTranscriptWrite(async () => {
    await bootstrapHarnessContextEngine({
      admittedRunContext: attempt.admittedRunContext,
      hadSessionFile: transcriptState.hasBootstrapTranscriptState,
      contextEngine: input.activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      sessionManager,
      // The admitted user turn is already persisted above. Fence bootstrap like
      // assemble is fenced; otherwise the engine imports the pending turn from
      // the transcript, the host appends it again, and the next run drops one
      // copy so every later provider byte shifts and the prompt cache misses.
      transcriptReadFence: attempt.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      runtimeContext: buildAfterTurnRuntimeContext({
        attempt,
        workspaceDir: input.effectiveWorkspace,
        cwd: input.effectiveCwd,
        agentDir: input.agentDir,
        tokenBudget: attempt.contextTokenBudget,
        activeAgentId: input.sessionAgentId,
        contextEnginePluginId: input.resolveActiveContextEnginePluginId(),
      }),
      contextEngineHostSupport: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      providerId: attempt.provider,
      requestedModelId: attempt.requestedModelId,
      modelId: attempt.modelId,
      fallbackReason: attempt.fallbackReason,
      degradedReason: attempt.degradedReason,
      runMaintenance: async (contextParams) =>
        await runContextEngineMaintenance({
          ...contextParams,
          sessionManager: contextParams.sessionManager as never,
          config: attempt.config,
          agentId: input.sessionAgentId,
          contextEngineAgentId: attempt.contextEngineAgentId,
        }),
      warn: (message) => log.warn(message),
    });
  });
  // Bootstrap may repair or migrate transcript rows. Only user writes after
  // preparation can be the active prompt source at the provider boundary.
  latestPersistedUserMessage = undefined;
  latestRuntimeUserMessage = undefined;
  userTranscriptContextRegistry.clear();

  return {
    prepareInitialUserTurnReplay,
    userMessageBoundary: {
      getUserTranscriptContexts: () => {
        const transcriptMessage =
          latestPersistedUserMessage ?? latestUserTurnTranscriptRecorder?.getPersistedMessage?.();
        // A suppressed retry reuses the canonical persisted row, while the SDK
        // may rebuild its runtime object. Match against that row as the stable
        // fallback after preferring the exact suppressed runtime correlation.
        const runtimeMessage =
          latestRuntimeUserMessage ??
          (attempt.suppressNextUserMessagePersistence ? transcriptMessage : undefined);
        return userTranscriptContextRegistry.list(runtimeMessage, transcriptMessage);
      },
      preparedUserTurnMessage,
    },
    isOpenAIResponsesApi,
    preparedUserTurnMessage,
    sessionManager,
    transcriptPolicy,
  };
}
