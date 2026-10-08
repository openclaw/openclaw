import path from "node:path";
import { isPathRelativeEscape } from "@openclaw/fs-safe/path";
import { MAX_IMAGE_BYTES } from "@openclaw/media-core/constants";
import type { ModelCompatConfig } from "../../../config/types.models.js";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../../context-engine/types.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
} from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import type { PluginMetadataSnapshot } from "../../../plugins/plugin-metadata-snapshot.types.js";
import {
  resolveProviderRuntimePluginHandle,
  type ProviderRuntimePluginHandle,
} from "../../../plugins/provider-hook-runtime.js";
import { createStageTimingTracker } from "../../../shared/stage-timing.js";
import { isHeartbeatLifecycleRunKind } from "../../bootstrap-mode.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../defaults.js";
import type { EmbeddedContextFile } from "../../embedded-agent-helpers/context-file.js";
import { resolveImageSanitizationLimits } from "../../image-sanitization.js";
import type { SandboxContext } from "../../sandbox/types.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairingForModel } from "../../session-transcript-repair.js";
import type { AgentSession } from "../../sessions/index.js";
import { invalidateComputerFrameIfMissing } from "../../tools/computer-tool.js";
import { resolveAttemptWorkspaceSandbox } from "../../workspace-sandbox.js";
import { isCacheTtlEligibleProvider, readLastCacheTtlTimestamp } from "../cache-ttl.js";
import { log } from "../logger.js";
import { declarePromptHistoryRewrite } from "../prompt-cache-observability.js";
import {
  getEmbeddedSessionPromptState,
  type ToolResultPromptProjectionState,
} from "../session-prompt-state.js";
import {
  installContextEngineLoopHook,
  installToolResultContextGuard,
} from "../tool-result-context-guard.js";
import {
  pruneExpiredCacheTtlToolResults,
  resolveCacheTtlPruningSettings,
  resolveLiveToolResultMaxChars,
} from "../tool-result-truncation.js";
import { mapThinkingLevel, mapThinkingLevelForProvider } from "../utils.js";
import { buildLoopPromptCacheInfo } from "./attempt-context-engine-helpers.js";
import { configureEmbeddedAttemptHttpRuntime } from "./attempt-http-runtime.js";
import { buildAfterTurnRuntimeContext } from "./attempt-prompt-helpers.js";
import {
  createEmbeddedRunStageSummaryEmitter,
  logEmbeddedRunStageSummary,
} from "./attempt-stage-timing.js";
import { installHistoryImagePruneContextTransform } from "./history-image-prune.js";
import type { MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./types.js";

type PreparedProviderRuntimePluginHandle = ProviderRuntimePluginHandle & {
  modelId: string;
  prepared: true;
};

export type EmbeddedAttemptSetup = Awaited<ReturnType<typeof prepareEmbeddedAttemptSetup>>;

export async function prepareEmbeddedAttemptSetup(params: EmbeddedRunAttemptParams) {
  // Ultra is a logical orchestration mode, not a provider effort. Preserve it for
  // prompt/status surfaces, then lower only at agent-core and provider boundaries.
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel, params.model);
  const agentCoreThinkingLevel = mapThinkingLevel(providerThinkingLevel);
  const proactiveSubagentOrchestration = params.thinkLevel === "ultra";
  configureEmbeddedAttemptHttpRuntime({ timeoutMs: params.timeoutMs });

  log.debug(
    `embedded run start: runId=${params.runId} sessionId=${params.sessionId} provider=${params.provider} model=${params.modelId} thinking=${params.thinkLevel} messageChannel=${params.messageChannel ?? params.messageProvider ?? "unknown"}`,
  );
  const prepStages = createStageTimingTracker(Date.now);
  const emitPrepStageSummary = createEmbeddedRunStageSummaryEmitter({
    label: "prep stages",
    log,
    runId: params.runId,
    sessionId: params.sessionId,
    tracker: prepStages,
  });
  const emitCorePluginToolStageSummary = (
    phase: string,
    summary: ReturnType<typeof prepStages.snapshot>,
  ) => {
    if (summary.stages.length === 0) {
      return;
    }
    logEmbeddedRunStageSummary(
      summary,
      log,
      () =>
        `[trace:embedded-run] core-plugin-tool stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
      { totalThresholdMs: 5_000, stageThresholdMs: 2_000 },
    );
  };

  const workspace = await resolveAttemptWorkspaceSandbox(params);
  const { effectiveWorkspace } = workspace;

  const getCurrentAttemptPluginMetadataSnapshot = (): PluginMetadataSnapshot | undefined =>
    params.preparedModelRuntime?.metadataSnapshot;
  let providerRuntimeHandle = params.runtimePlan?.providerRuntimeHandle as
    | PreparedProviderRuntimePluginHandle
    | undefined;
  const getProviderRuntimeHandle = (): PreparedProviderRuntimePluginHandle => {
    if (
      providerRuntimeHandle &&
      providerRuntimeHandle.prepared &&
      providerRuntimeHandle.provider === params.provider &&
      providerRuntimeHandle.modelId === params.modelId &&
      providerRuntimeHandle.workspaceDir === effectiveWorkspace
    ) {
      return providerRuntimeHandle;
    }
    const pluginMetadataSnapshot = getCurrentAttemptPluginMetadataSnapshot();
    providerRuntimeHandle = {
      ...resolveProviderRuntimePluginHandle({
        provider: params.provider,
        modelId: params.modelId,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        env: process.env,
        ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
      }),
      provider: params.provider,
      modelId: params.modelId,
      prepared: true,
      workspaceDir: effectiveWorkspace,
    };
    return providerRuntimeHandle;
  };
  prepStages.mark("workspace-sandbox");

  return {
    agentCoreThinkingLevel,
    ...workspace,
    emitCorePluginToolStageSummary,
    emitPrepStageSummary,
    getCurrentAttemptPluginMetadataSnapshot,
    getProviderRuntimeHandle,
    prepStages,
    proactiveSubagentOrchestration,
    providerThinkingLevel,
  };
}

type PromptCacheRetention = Parameters<typeof buildLoopPromptCacheInfo>[0]["retention"];

export function installEmbeddedAttemptContextGuards(input: {
  activeContextEngine?: ContextEngine;
  activeSession: AgentSession;
  agentDir: string;
  attempt: EmbeddedRunAttemptParams;
  computerContextEpoch: { value: number };
  dropThinkingBlocksForEstimate: boolean;
  effectiveCwd: string;
  effectiveFsWorkspaceOnly: boolean;
  effectiveWorkspace: string;
  getPrePromptMessageCount: () => number;
  getPromptCache: () => EmbeddedRunAttemptResult["promptCache"];
  getPromptCacheRetention: () => PromptCacheRetention;
  getCompactionReplayEnabled: () => boolean;
  getServerToolClearingEnabled: () => boolean;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  getSystemPrompt: () => string;
  onCurrentTurnImageFailure?: (count: number) => void;
  isOpenAIResponsesApi: boolean;
  repairToolUseResultPairing: boolean;
  sessionAgentId: string;
  sessionManager: ReturnType<typeof guardSessionManager>;
  settingsManager: AgentSession["settingsManager"];
  sandbox?: SandboxContext | null;
}) {
  const { activeContextEngine, activeSession, attempt, settingsManager } = input;
  const contextTokenBudget = Math.max(
    1,
    Math.floor(
      attempt.contextTokenBudget ??
        attempt.model.contextWindow ??
        attempt.model.maxTokens ??
        DEFAULT_CONTEXT_TOKENS,
    ),
  );
  const toolResultMaxChars = resolveLiveToolResultMaxChars({
    contextWindowTokens: contextTokenBudget,
  });
  let pendingMidTurnPrecheckRequest: MidTurnPrecheckRequest | null = null;
  let afterTurnCheckpoint: number | null = null;
  const midTurnPrecheckOptions =
    attempt.config?.agents?.defaults?.compaction?.midTurnPrecheck?.enabled === true
      ? {
          midTurnPrecheck: {
            enabled: true,
            getReplay: () => ({
              model: attempt.model,
              sessionId: attempt.sessionId,
              authProfileId: attempt.runtimePlan?.auth.forwardedAuthProfileId,
              enabled: input.getCompactionReplayEnabled(),
            }),
            contextTokenBudget,
            reserveTokens: () => settingsManager.getCompactionReserveTokens(),
            toolResultMaxChars,
            getSystemPrompt: input.getSystemPrompt,
            getPrePromptMessageCount: input.getPrePromptMessageCount,
            onMidTurnPrecheck: (request: MidTurnPrecheckRequest) => {
              pendingMidTurnPrecheckRequest = request;
            },
          },
        }
      : {};

  const cacheTtlCompat: ModelCompatConfig | undefined = attempt.model.compat;
  const contextPruning = attempt.config?.agents?.defaults?.contextPruning;
  // Disabled pruning must not resolve provider hooks and cold-load plugin metadata.
  const cacheTtlSettings =
    contextPruning?.mode === "cache-ttl" &&
    isCacheTtlEligibleProvider(attempt.provider, attempt.modelId, attempt.model.api, {
      baseUrl: attempt.model.baseUrl,
      supportsPromptCacheKey: cacheTtlCompat?.supportsPromptCacheKey,
    })
      ? resolveCacheTtlPruningSettings(contextPruning)
      : undefined;
  const previousCacheTtlTransform = activeSession.agent.transformContext;
  let lastCacheTouchAt = cacheTtlSettings
    ? readLastCacheTtlTimestamp(input.sessionManager, {
        provider: attempt.provider,
        modelId: attempt.modelId,
      })
    : null;
  if (cacheTtlSettings) {
    activeSession.agent.transformContext = async (messages, signal) => {
      const sourceMessages = previousCacheTtlTransform
        ? await previousCacheTtlTransform.call(activeSession.agent, messages, signal)
        : messages;
      return pruneExpiredCacheTtlToolResults({
        messages: sourceMessages,
        settings: cacheTtlSettings,
        contextWindowTokens: contextTokenBudget,
        lastCacheTouchAt,
        dropThinkingBlocksForEstimate: input.dropThinkingBlocksForEstimate,
        now: Date.now(),
        projectionState: input.toolResultPromptProjectionState,
        // Server-side clearing owns new rounds; earlier client projections still
        // replay so the prefix already sent for this session does not change.
        pruneNewRounds: !input.getServerToolClearingEnabled(),
        onPruned: () => {
          declarePromptHistoryRewrite({ ...attempt, reason: "pruning" });
          lastCacheTouchAt = Date.now();
        },
      });
    };
  }

  let removeContextEngineLoopHook: (() => void) | undefined;
  if (activeContextEngine?.info.ownsCompaction === true) {
    const selectedContextEngineId = activeContextEngine.info.id;
    const runtimeSettings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      provider: attempt.provider,
      requestedModel: attempt.requestedModelId,
      resolvedModel: attempt.modelId,
      selectedContextEngineId,
      contextEngineSelectionSource: selectedContextEngineId === "legacy" ? "default" : "configured",
      promptTokenBudget: attempt.contextTokenBudget,
      fallbackReason: attempt.fallbackReason,
      degradedReason: attempt.degradedReason,
    });
    removeContextEngineLoopHook = installContextEngineLoopHook({
      agent: activeSession.agent,
      contextEngine: activeContextEngine,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
      sessionFile: attempt.sessionFile,
      tokenBudget: attempt.contextTokenBudget,
      modelId: attempt.modelId,
      ...(input.repairToolUseResultPairing
        ? {
            repairAssembledMessages: (messages) =>
              sanitizeToolUseResultPairingForModel(messages, input.isOpenAIResponsesApi),
          }
        : {}),
      getPrePromptMessageCount: input.getPrePromptMessageCount,
      // Only the outer accepted-turn owner may advance an admitted engine.
      deferredTurn: attempt.onContextEngineTurnCandidate
        ? {
            prompt: attempt.prompt,
            get availableTools() {
              return new Set(activeSession.agent.state.tools.map((tool) => tool.name));
            },
          }
        : undefined,
      onAfterTurnCheckpoint: (messageCount) => {
        afterTurnCheckpoint = messageCount;
      },
      getRuntimeContext: ({ messages, prePromptMessageCount }) =>
        buildAfterTurnRuntimeContext({
          attempt,
          workspaceDir: input.effectiveWorkspace,
          cwd: input.effectiveCwd,
          agentDir: input.agentDir,
          tokenBudget: attempt.contextTokenBudget,
          promptCache:
            input.getPromptCache() ??
            buildLoopPromptCacheInfo({
              messagesSnapshot: messages,
              prePromptMessageCount,
              retention: input.getPromptCacheRetention(),
              fallbackLastCacheTouchAt: readLastCacheTtlTimestamp(input.sessionManager, {
                provider: attempt.provider,
                modelId: attempt.modelId,
              }),
            }),
        }),
      runtimeSettings,
      isHeartbeat: isHeartbeatLifecycleRunKind(attempt.bootstrapContextRunKind),
    });
  }
  const removeToolResultGuard = installToolResultContextGuard({
    agent: activeSession.agent,
    contextWindowTokens: contextTokenBudget,
    ...midTurnPrecheckOptions,
  });

  const removeHistoryImagePruneContextTransform = installHistoryImagePruneContextTransform(
    activeSession.agent,
    {
      workspaceDir: input.effectiveWorkspace,
      agentWorkspaceDir: attempt.workspaceDir,
      model: attempt.model,
      maxBytes: MAX_IMAGE_BYTES,
      maxDimensionPx: resolveImageSanitizationLimits(attempt.config).maxDimensionPx,
      workspaceOnly: input.effectiveFsWorkspaceOnly,
      localRoots: input.effectiveFsWorkspaceOnly
        ? undefined
        : getAgentScopedMediaLocalRoots(attempt.config ?? {}, input.sessionAgentId),
      sandbox:
        input.sandbox?.enabled && input.sandbox.fsBridge
          ? { root: input.sandbox.workspaceDir, bridge: input.sandbox.fsBridge }
          : undefined,
      onCurrentTurnImageFailure: input.onCurrentTurnImageFailure,
    },
    (pruned) => {
      const promptState = getEmbeddedSessionPromptState(attempt.sessionId);
      const keys = new Set(
        [...pruned].map(([index, message]) => `${index}:${message.role}:${message.timestamp}`),
      );
      if ([...keys].some((key) => !promptState.prunedImageMessages?.has(key))) {
        declarePromptHistoryRewrite({ ...attempt, reason: "imageCleanup" });
      }
      promptState.prunedImageMessages = keys;
    },
  );
  const previousComputerFrameTransform = activeSession.agent.transformContext;
  activeSession.agent.transformContext = async (messages, signal) => {
    const modelContext = previousComputerFrameTransform
      ? await previousComputerFrameTransform.call(activeSession.agent, messages, signal)
      : messages;
    invalidateComputerFrameIfMissing({
      contextEpoch: input.computerContextEpoch,
      messages: modelContext,
      imagesBlocked: settingsManager.getBlockImages(),
    });
    return modelContext;
  };

  return {
    getAfterTurnCheckpoint: () => afterTurnCheckpoint,
    recordCacheTouch: (startedAt: number) => {
      lastCacheTouchAt = startedAt;
    },
    remove: () => {
      activeSession.agent.transformContext = previousComputerFrameTransform;
      removeHistoryImagePruneContextTransform();
      removeToolResultGuard();
      removeContextEngineLoopHook?.();
      activeSession.agent.transformContext = previousCacheTtlTransform;
    },
    takePendingMidTurnPrecheckRequest: () => {
      const request = pendingMidTurnPrecheckRequest;
      pendingMidTurnPrecheckRequest = null;
      return request;
    },
  };
}

export type EmitDiagnosticRunCompleted = (
  outcome: "completed" | "aborted" | "blocked" | "error",
  err?: unknown,
  extra?: { blockedBy?: string },
) => void;

export function startEmbeddedAttemptDiagnostics(params: EmbeddedRunAttemptParams) {
  const diagnosticTrace = freezeDiagnosticTraceContext(
    getActiveDiagnosticTraceContext() ?? createDiagnosticTraceContext(),
  );
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(diagnosticTrace));
  const diagnosticRunBase = {
    runId: params.runId,
    ...(params.agentId && { agentId: params.agentId }),
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.sessionId && { sessionId: params.sessionId }),
    provider: params.provider,
    model: params.modelId,
    trigger: params.trigger,
    ...((params.messageChannel ?? params.messageProvider)
      ? { channel: params.messageChannel ?? params.messageProvider }
      : {}),
    trace: runTrace,
  };
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...diagnosticRunBase,
  });
  const startedAt = Date.now();
  let completed = false;
  const emitCompleted: EmitDiagnosticRunCompleted = (outcome, err, extra) => {
    if (completed) {
      return;
    }
    completed = true;
    const failed = err != null && outcome !== "blocked";
    const errorMessage = failed ? diagnosticErrorMessage(err) : undefined;
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - startedAt,
        outcome,
        ...(extra?.blockedBy ? { blockedBy: extra.blockedBy } : {}),
        ...(failed ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      },
      errorMessage ? { errorMessage } : undefined,
    );
  };
  return { diagnosticTrace, runTrace, emitCompleted };
}

/**
 * Rewrites injected context file paths when a bootstrap assembled in one
 * workspace is replayed in another. Files outside the source workspace keep
 * their original absolute path to avoid manufacturing unsafe relative paths.
 */
export function remapInjectedContextFilesToWorkspace(params: {
  files: EmbeddedContextFile[];
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
}): EmbeddedContextFile[] {
  if (params.sourceWorkspaceDir === params.targetWorkspaceDir) {
    return params.files;
  }
  return params.files.map((file) => {
    const relative = path.relative(params.sourceWorkspaceDir, file.path);
    return !isPathRelativeEscape(relative)
      ? {
          ...file,
          path:
            relative === ""
              ? params.targetWorkspaceDir
              : path.join(params.targetWorkspaceDir, relative),
        }
      : file;
  });
}
