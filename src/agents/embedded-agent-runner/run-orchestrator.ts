import { AsyncLocalStorage } from "node:async_hooks";
import {
  createAgentLifecycleTerminalBackstop,
  resolveAgentLifecycleTerminalMetadata,
} from "../../auto-reply/reply/agent-lifecycle-terminal.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { prepareCronRootSessionGeneration } from "../../config/sessions/session-delivery-generation.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { revokeMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../../infra/agent-events.js";
import { captureExecRequestOwners, withExecRequestTurn } from "../../infra/exec-request-context.js";
import {
  buildHandledBeforeAgentReplyPayloads,
  runBeforeAgentReplyForTurn,
} from "../../plugins/before-agent-reply.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import {
  runOutsidePluginRuntimeGenerationScope,
  withPluginRuntimeGenerationScope,
} from "../../plugins/runtime/generation-scope.js";
import {
  AsyncWorkScope,
  captureAsyncWorkTracker,
  getAsyncWorkSignal,
} from "../../shared/async-work-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createStageTimingTracker } from "../../shared/stage-timing.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveModelFallbackAvailability,
  resolveRunModelFallbacksOverride,
} from "../agent-scope.js";
import { createAssistantErrorTranscript } from "../assistant-error-transcript.js";
import { runBestEffortCallback } from "../embedded-agent-subscribe.callback.js";
import type { AgentHarnessPluginSelection } from "../harness/runtime-plugin-load-plan.js";
import { resolveLegacyInheritedAuthDir } from "../legacy-inherited-auth-dir.js";
import { resolveModelCandidateChain } from "../model-fallback-candidates.js";
import {
  getPreparedModelRuntimePluginGeneration,
  runOutsidePreparedModelRuntimePluginGenerationScope,
  withPreparedModelRuntimePluginGenerationScope,
} from "../prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  acquireReadOnlyPreparedModelRuntime,
} from "../prepared-model-runtime.js";
import { prepareAgentPromptProjects } from "../prompt-projects.js";
import { settleFailedRequesterRun, settleRequesterRun } from "../requester-run-settlement.js";
import { resolveAgentRunErrorLifecycleFields } from "../run-termination.js";
import { withRequiredSessionPlacement } from "../session-placement-admission.js";
import { resolveSessionPlacementTurnSettlementAssertion } from "../session-placement-forced-terminal-settlement.js";
import {
  resolveSessionSuspensionTarget,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { SessionManager } from "../sessions/session-manager.js";
import { redactRunIdentifier } from "../workspace-run.js";
import { runEmbeddedAgentViaCliBackendIfEligible } from "./cli-backend-dispatch.js";
import { waitForDeferredTurnMaintenanceForSession } from "./context-engine-maintenance.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { createEmbeddedAgentPluginRuntimeRefresh } from "./plugin-runtime-refresh.js";
import { runPreparedEmbeddedLoop } from "./run-loop.js";
import { createEmbeddedRunStageSummaryEmitter } from "./run/attempt-stage-timing.js";
import { withExecutionPhaseDiagnostics } from "./run/execution-phase-diagnostics.js";
import type {
  RunEmbeddedAgentInternalParams,
  RunEmbeddedAgentParamsWithSessionFile,
} from "./run/internal-params.js";
import { createEmbeddedRunLaneController } from "./run/lane-controller.js";
import {
  assertInitialOperatorModelPolicy,
  resolveEmbeddedRunConfig,
} from "./run/model-admission.js";
import {
  bindRunToPreparedModelRuntime,
  resolvePreparedRuntimeWorkspaces,
} from "./run/prepared-runtime-context.js";
import { createEmbeddedRunProgressController } from "./run/progress-controller.js";
import { createRecoveryMessageActionTurnCapability } from "./run/recovery-message-action-capability.js";
import { resolveInitialEmbeddedRunModel } from "./run/runtime-resolution.js";
import { prepareEmbeddedRunSession } from "./run/session-bootstrap.js";
import type { EmbeddedAgentRunResult } from "./types.js";
import {
  createUsageAccumulator,
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "./usage-accumulator.js";

const EMPTY_EMBEDDED_AGENT_CONFIG: OpenClawConfig = Object.freeze({});

export function runEmbeddedAgent(
  internalParamsInput: RunEmbeddedAgentInternalParams,
): Promise<EmbeddedAgentRunResult> {
  const config = resolveEmbeddedRunConfig(internalParamsInput);
  const lifecycleGeneration =
    internalParamsInput.lifecycleGeneration ??
    captureAgentRunLifecycleGeneration(internalParamsInput.runId);
  // Isolated probes acquire their own read-only runtime snapshot. Carrying the caller's
  // ambient generation makes the admission guard reject that independent snapshot.
  const pluginGeneration =
    internalParamsInput.pluginGeneration ??
    (internalParamsInput.preparedModelRuntimeMode === "isolated-read-only"
      ? undefined
      : getPreparedModelRuntimePluginGeneration());
  return withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
    const prepared = await prepareEmbeddedRunSession({
      ...internalParamsInput,
      config,
      lifecycleGeneration,
      ...(pluginGeneration ? { pluginGeneration } : {}),
    });
    return await withRequiredSessionPlacement(
      prepared.runSessionTarget,
      {
        config: prepared.params.config,
        assertCurrent: prepared.params.preparedRunAdmission?.assertSourceCurrent,
        signal: prepared.params.abortSignal,
      },
      () => runEmbeddedAgentForSession(prepared),
    );
  });
}

async function runEmbeddedAgentForSession(
  prepared: Awaited<ReturnType<typeof prepareEmbeddedRunSession>>,
): Promise<EmbeddedAgentRunResult> {
  const {
    params: paramsBase,
    runSessionTarget,
    contextEngineAgentId,
    queuedLifecycleGeneration,
  } = prepared;
  let sessionAdmission = prepared.sessionAdmission;
  let lifecycleGeneration = paramsBase.lifecycleGeneration!;
  let params: RunEmbeddedAgentParamsWithSessionFile = withExecutionPhaseDiagnostics({
    ...paramsBase,
    // Establish one detached transcript owner for CLI dispatch and every retry.
    sessionManager:
      paramsBase.sessionManager ??
      (paramsBase.sessionPersistence === "detached"
        ? SessionManager.inMemory(paramsBase.cwd ?? paramsBase.workspaceDir)
        : undefined),
  });
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane, params);
  // Outer fallback attempts defer session suspension only while another
  // candidate remains. Direct and final-candidate runs suspend normally.
  // Detached runs neither write durable metadata nor claim the outer deferral.
  const failureSuspension =
    params.sessionPersistence === "detached" ? undefined : resolveSessionSuspensionTarget();
  const suspendForFailure = (suspensionParams: SessionSuspensionParams) => {
    if (!failureSuspension) {
      return;
    }
    const suspension = {
      ...suspensionParams,
      // A caller-supplied id wins; the run owns unregistered agent directories.
      agentId: suspensionParams.agentId ?? params.agentId,
    };
    if (failureSuspension.mode === "defer") {
      failureSuspension.defer(suspension);
      return;
    }
    void suspendSession(suspension);
  };
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => params,
    globalLane,
    initialQueuedLifecycleGeneration: queuedLifecycleGeneration,
    sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      params = nextParams;
    },
    onSessionWriterClaimed: (entry) => {
      if (sessionAdmission) {
        // Native preparation must consume the claim's postimage, not the pre-queue row.
        sessionAdmission = { ...sessionAdmission, entry };
      }
    },
  });
  const { enqueueGlobal, enqueueSession, noteLaneTaskProgress, throwIfAborted } = laneController;
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (!channelHint || isMarkdownCapableMessageChannel(channelHint) ? "markdown" : "plain");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;
  throwIfAborted();

  const recoveryMessageActionTurnCapability = createRecoveryMessageActionTurnCapability(params);
  if (recoveryMessageActionTurnCapability) {
    // A recovered run reconstructs this capability from the exact durable
    // source claim; revocation below keeps it scoped to this run lifetime.
    params = { ...params, messageActionTurnCapability: recoveryMessageActionTurnCapability };
  }

  const requestOwners = captureExecRequestOwners(params);
  const runSession = async () => {
    throwIfAborted();
    // Same-session reads below must see any prior deferred transcript rewrite.
    // Checkpoint before the global lane so unrelated sessions can still start
    // while this session waits on its own maintenance lane.
    if (!params.sessionManager || params.sessionManager.getSessionTarget()) {
      params.replyOperation?.markWaitingForDeferredMaintenance();
      try {
        await waitForDeferredTurnMaintenanceForSession(params.sessionKey);
        // Maintenance can finish while its transcript projection is still rebuilding.
        // Settle that projection before the next attempt reads the bounded history.
        await waitForSessionTranscriptProjection(runSessionTarget, laneController.abortSignal);
      } finally {
        params.replyOperation?.markDeferredMaintenanceWaitEnded();
      }
    }
    throwIfAborted();
    return enqueueGlobal(async () => {
      const started = Date.now();
      const refresh = createEmbeddedAgentPluginRuntimeRefresh(params);
      const usage = createUsageAccumulator();
      let refreshed = false;
      let generationCleanup = Promise.resolve();
      let terminal: ReturnType<typeof createAgentLifecycleTerminalBackstop> | undefined;
      let assistantErrorTranscript: ReturnType<typeof createAssistantErrorTranscript> | undefined;
      const ownsAssistantErrorTranscript = params.assistantErrorTranscript === undefined;
      const onAgentEvent = params.onAgentEvent;
      const onAttemptStart = params.onAttemptStart;
      const runGeneration = async (): Promise<EmbeddedAgentRunResult> => {
        throwIfAborted();
        assertInitialOperatorModelPolicy(params, sessionAdmission?.entry);
        // Subscription-scoped claude-cli auth executes via the CLI backend;
        // resolved post-admission so dispatched runs obey the same lifecycle,
        // placement, and concurrency gates as native embedded runs.
        const cliDispatched = await runEmbeddedAgentViaCliBackendIfEligible({
          ...params,
          // Preserve the admitted writer claim alongside the already resolved storage identity.
          sessionTarget: { ...params.sessionTarget, ...runSessionTarget },
        });
        if (cliDispatched) {
          return cliDispatched;
        }
        const preReplyTarget = { ...runSessionTarget, ...params.sessionTarget };
        const preReplyGeneration = await prepareCronRootSessionGeneration(
          {
            ...preReplyTarget,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey ?? preReplyTarget.sessionKey,
            lifecycleRevision: preReplyTarget.expectedLifecycleRevision,
          },
          (reason) => laneController.laneTaskAbortController.abort(reason),
        );
        using _ = { [Symbol.dispose]: () => preReplyGeneration?.release() };
        const preReplyAssertCurrent = preReplyGeneration?.assertCurrent;
        const startupStages = createStageTimingTracker(Date.now);
        const {
          requestedWorkspaceResolution,
          runtimeWorkspaceResolution,
          preserveExecutionWorkspace,
        } = resolvePreparedRuntimeWorkspaces(params);
        startupStages.mark("workspace");
        const config = params.config ?? EMPTY_EMBEDDED_AGENT_CONFIG;
        const requestedAgentDir =
          params.agentDir ?? resolveAgentDir(config, requestedWorkspaceResolution.agentId);
        const retainIdleRunOwner = params.config === undefined;
        const requestedRuntimeSelection = resolveInitialEmbeddedRunModel({
          config,
          agentId: requestedWorkspaceResolution.agentId,
          provider: params.provider,
          model: params.model,
        });
        const explicitHarnessRuntime = params.agentHarnessId ?? params.agentHarnessRuntimeOverride;
        const requestedHarnessRuntime =
          explicitHarnessRuntime ?? params.agentHarnessRuntimePreparationHint;
        const runtimePluginFallbacksOverride =
          params.modelFallbacksOverride ??
          resolveRunModelFallbacksOverride({
            cfg: config,
            agentId: requestedWorkspaceResolution.agentId,
            sessionKey: params.sessionKey,
          });
        const pluginMetadataSnapshot =
          params.pluginGeneration?.pluginMetadataSnapshot ??
          loadPluginMetadataSnapshot({
            config,
            workspaceDir: runtimeWorkspaceResolution.workspaceDir,
            env: process.env,
          });
        const runtimePluginSelections = resolveModelCandidateChain({
          cfg: config,
          agentId: requestedWorkspaceResolution.agentId,
          manifestPlugins: pluginMetadataSnapshot,
          provider: requestedRuntimeSelection.provider,
          model: requestedRuntimeSelection.modelId,
          requestedRouteResolution: params.requestedRouteResolution,
          fallbacksOverride: runtimePluginFallbacksOverride,
        }).map((candidate, index): AgentHarnessPluginSelection =>
          Object.assign(
            { provider: candidate.provider, modelId: candidate.model },
            // Preparation hints apply only to the requested route; fallbacks resolve their own policy.
            requestedHarnessRuntime && (index === 0 || explicitHarnessRuntime)
              ? { runtime: requestedHarnessRuntime }
              : {},
            { agentId: requestedWorkspaceResolution.agentId },
          ),
        );
        const preparedInput = {
          config,
          agentId: requestedWorkspaceResolution.agentId,
          agentDir: requestedAgentDir,
          // Shared credential inheritance stays anchored to its compatibility owner;
          // the selected session agent already owns this prepared runtime.
          inheritedAuthDir: resolveLegacyInheritedAuthDir(config),
          workspaceDir: runtimeWorkspaceResolution.workspaceDir,
          preserveWorkspaceDirOnRefresh: !runtimeWorkspaceResolution.isCanonicalWorkspace,
          ...(params.allowGatewaySubagentBinding ? { allowGatewaySubagentBinding: true } : {}),
          ...(params.preparedModelRuntimeMode === "isolated-read-only"
            ? { loadRuntimePlugins: true }
            : {}),
          runtimePluginSelections,
        };
        startupStages.mark("harness-selection");
        const callerResult = createDeferredCore<EmbeddedAgentRunResult>();
        const trackOwner = captureAsyncWorkTracker();
        const parentSignal = getAsyncWorkSignal();
        const work = new AsyncWorkScope();
        let context = work.run(() => AsyncLocalStorage.snapshot());
        let preparedRuntimeResource: AsyncDisposable | undefined;
        let initialWriterResource: AsyncDisposable | undefined;
        let initialWriterCleanup = Promise.resolve();
        const runPreparedCandidate = async () => {
          // Configless direct hosts reuse one idle generation. The prepared-runtime lifecycle keeps
          // gateway run generations in its own bounded cache so one-off paths cannot accumulate.
          // Runtime acquisition owns its build bound before the attempt budget starts.
          // Suspend lane-idle inference without inventing progress; Stop still cancels admission.
          laneController.setLaneTaskDeadline({ kind: "unlimited" });
          // Probe homes outlive only the attempt client, not independent live catalog clients.
          const isolatedReadOnly = params.preparedModelRuntimeMode === "isolated-read-only";
          const acquireRuntime = isolatedReadOnly
            ? acquireReadOnlyPreparedModelRuntime
            : acquireAgentRunPreparedModelRuntime;
          const preparedModelRuntimeLease = await acquireRuntime(preparedInput, {
            abortSignal: laneController.abortSignal,
            // Turns need only configured admission facts; inventory remains a lazy snapshot load.
            catalogMode: "static",
            ...(!isolatedReadOnly
              ? {
                  retainIdleRunOwner,
                  ...(params.pluginGeneration ? { pluginGeneration: params.pluginGeneration } : {}),
                }
              : {}),
          }).finally(() => {
            noteLaneTaskProgress();
            laneController.setLaneTaskDeadline(undefined);
          });
          preparedRuntimeResource = preparedModelRuntimeLease;
          startupStages.mark("prepared-runtime");
          const preparedModelRuntimeOwnerSnapshot = preparedModelRuntimeLease.snapshot;
          let preparedLeaseActive = true;
          try {
            throwIfAborted();
            if (
              params.pluginGeneration &&
              preparedModelRuntimeOwnerSnapshot.metadataSnapshot !==
                params.pluginGeneration.pluginMetadataSnapshot
            ) {
              throw new Error("prepared model runtime replaced the admitted plugin generation");
            }
            // A reload may complete while admission waits. The committed generation owns config,
            // directories, model selection, hooks, fallbacks, and every later run projection.
            const rebound = bindRunToPreparedModelRuntime({
              runParams: params,
              requestedWorkspaceResolution,
              preserveExecutionWorkspace,
              preparedModelRuntime: preparedModelRuntimeOwnerSnapshot,
            });
            params = rebound.runParams;
            const workspaceResolution = rebound.workspaceResolution;
            const projects = await prepareAgentPromptProjects({
              config: params.config,
              workspaceDir: workspaceResolution.workspaceDir,
              cwd: params.cwd,
              sessionId: params.sessionId,
            });
            const { activeProjectKeys } = projects;
            const preparedModelRuntime = Object.freeze({
              ...preparedModelRuntimeOwnerSnapshot,
              ...projects,
            });
            const runPrepared = async () => {
              params = refresh.withDeliveryCallbacks(params);
              const preparedAgentId = workspaceResolution.agentId;
              const resolvedWorkspace = workspaceResolution.workspaceDir;
              const agentDir = preparedModelRuntime.agentDir;
              const progressController = createEmbeddedRunProgressController({
                attempt: params,
                noteLaneTaskProgress,
                startedAtMs: started,
              });
              const { notifyExecutionPhase } = progressController;
              const emitStartupStageSummary = createEmbeddedRunStageSummaryEmitter({
                label: "startup stages",
                log,
                runId: params.runId,
                sessionId: params.sessionId,
                tracker: startupStages,
              });
              await params.onExecutionStarted?.({ lifecycleGeneration });
              throwIfAborted();
              assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
              notifyExecutionPhase("runner_entered");
              const canonicalWorkspace = resolveUserPath(
                resolveAgentWorkspaceDir(preparedModelRuntime.config, preparedAgentId),
              );
              const isCanonicalWorkspace = canonicalWorkspace === resolvedWorkspace;
              const redactedSessionId = redactRunIdentifier(params.sessionId);
              const redactedSessionKey = redactRunIdentifier(params.sessionKey);
              const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
              if (requestedWorkspaceResolution.usedFallback) {
                log.warn(
                  `[workspace-fallback] caller=runEmbeddedAgent reason=${requestedWorkspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${preparedAgentId} workspace=${redactedWorkspace}`,
                );
              }
              startupStages.mark("runtime-context");
              notifyExecutionPhase("workspace");
              startupStages.mark("runtime-plugins");
              notifyExecutionPhase("runtime_plugins");

              const { provider, modelId } = resolveInitialEmbeddedRunModel({
                config: params.config,
                agentId: workspaceResolution.agentId,
                provider: params.provider,
                model: params.model,
              });
              const normalizedSessionKey = params.sessionKey?.trim();
              const modelFallbackAvailability =
                (params.resolvedModelSelection?.fallbacksOverride === undefined
                  ? params.modelFallbackAvailability
                  : undefined) ??
                resolveModelFallbackAvailability({
                  cfg: params.config ?? EMPTY_EMBEDDED_AGENT_CONFIG,
                  agentId: workspaceResolution.agentId,
                  sessionKey: normalizedSessionKey,
                  hasSessionModelOverride: false,
                  modelFallbacksOverride: params.modelFallbacksOverride,
                });
              const fallbackConfigured = modelFallbackAvailability.kind === "active";
              if (modelFallbackAvailability.kind === "disabled_by_model_override") {
                log.warn(
                  `[model-fallback] configured fallbacks disabled by user model override run=${params.runId} session=${redactedSessionId}`,
                );
              }
              const resolvedSessionKey = normalizedSessionKey ?? runSessionTarget.sessionKey;
              const hookRunner = getGlobalHookRunner();
              const hookCtx = {
                runId: params.runId,
                jobId: params.jobId,
                agentId: workspaceResolution.agentId,
                sessionKey: resolvedSessionKey,
                sessionId: params.sessionId,
                workspaceDir: resolvedWorkspace,
                activeProjectKeys: [...activeProjectKeys],
                modelProviderId: provider,
                modelId,
                trigger: params.trigger,
                ...buildAgentHookContextChannelFields(params),
                ...buildAgentHookContextIdentityFields(params),
              };
              const hookResult = await runBeforeAgentReplyForTurn({
                assertCurrent: preReplyAssertCurrent,
                runId: params.runId,
                trigger: params.trigger,
                event: { cleanedBody: params.prompt },
                context: hookCtx,
                onDispatch: () =>
                  notifyExecutionPhase("before_agent_reply", { provider, model: modelId }),
                onDeclined: () =>
                  notifyExecutionPhase("runtime_plugins", { provider, model: modelId }),
              });
              if (hookResult?.handled) {
                return {
                  payloads: buildHandledBeforeAgentReplyPayloads(hookResult.reply),
                  meta: {
                    durationMs: Date.now() - started,
                    agentMeta: {
                      sessionId: params.sessionId,
                      provider,
                      model: modelId,
                    },
                    finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
                    finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
                  },
                };
              }

              assistantErrorTranscript ??=
                params.assistantErrorTranscript ?? createAssistantErrorTranscript();
              terminal ??=
                (params.deferTerminalLifecycle ?? params.deferTerminalLifecycleEnd)
                  ? undefined
                  : createAgentLifecycleTerminalBackstop({
                      runId: params.runId,
                      sessionKey: params.sessionKey,
                      startedAt: started,
                      getLifecycleGeneration: () => lifecycleGeneration,
                      resolveTerminationFields: (error) =>
                        resolveAgentRunErrorLifecycleFields(error, params.abortSignal),
                      onTerminalEvent: (event) =>
                        runBestEffortCallback({
                          callback: () => onAgentEvent?.(event),
                          label: "lifecycle agent event",
                          log,
                        }),
                    });
              const runTerminal = terminal;
              return await runPreparedEmbeddedLoop(refresh, {
                preReplyGeneration,
                onInitialWriterPrepared: (resource) => {
                  initialWriterResource = resource;
                },
                runParams: {
                  ...params,
                  assistantErrorTranscript,
                  deferTerminalLifecycle: true,
                  onAttemptStart: () => {
                    runTerminal?.beginAttempt();
                    onAttemptStart?.();
                  },
                  onAgentEvent: runTerminal
                    ? (event) => {
                        runTerminal.note(event);
                        return onAgentEvent?.(event);
                      }
                    : onAgentEvent,
                },
                sessionAdmission,
                contextEngineAgentId,
                provider,
                modelId,
                agentDir,
                workspaceResolution,
                workspaceDir: resolvedWorkspace,
                bootstrapWorkspaceDir: canonicalWorkspace,
                isCanonicalWorkspace,
                globalLane,
                hookRunner,
                hookContext: hookCtx,
                fallbackConfigured,
                isProbeSession,
                resolvedSessionKey,
                resolvedToolResultFormat,
                startedAtMs: started,
                startupStages,
                emitStartupStageSummary,
                progressController,
                laneController,
                lifecycleGeneration,
                suspendForFailure,
                preparedModelRuntime,
              });
            };
            const runWithPreparedRuntime = () =>
              withPluginRuntimeGenerationScope(preparedModelRuntime, () => {
                context = AsyncLocalStorage.snapshot();
                return runPrepared();
              });
            return params.pluginGeneration
              ? await withPreparedModelRuntimePluginGenerationScope(
                  preparedModelRuntimeLease.pluginGeneration,
                  runWithPreparedRuntime,
                  () => (preparedLeaseActive ? preparedModelRuntimeOwnerSnapshot : undefined),
                )
              : await runWithPreparedRuntime();
          } finally {
            const initialWriter = initialWriterResource;
            if (initialWriter) {
              initialWriterCleanup = context(() =>
                work.track(async () => await initialWriter[Symbol.asyncDispose]()),
              );
              void initialWriterCleanup.catch(() => {});
            }
            preparedLeaseActive = false;
          }
        };
        // The lane reports its existing result while this owner retains actual cleanup work.
        generationCleanup = trackOwner(async () => {
          const closeWork = () => context(() => work.beginClose(parentSignal?.reason));
          parentSignal?.addEventListener("abort", closeWork, { once: true });
          if (parentSignal?.aborted) {
            closeWork();
          }
          try {
            callerResult.resolve(await work.track(runPreparedCandidate));
          } catch (error) {
            callerResult.reject(error);
          } finally {
            try {
              await AsyncWorkScope.runWhenAllIdle(
                () => [work],
                () => context(() => work.drain()),
              );
            } finally {
              try {
                try {
                  await initialWriterCleanup;
                } finally {
                  await preparedRuntimeResource?.[Symbol.asyncDispose]();
                }
              } finally {
                parentSignal?.removeEventListener("abort", closeWork);
              }
            }
          }
        });
        void generationCleanup.catch(callerResult.reject);
        return await callerResult.promise;
      };
      try {
        let failed = true;
        let result: EmbeddedAgentRunResult;
        try {
          for (;;) {
            const run = () => refresh.run(runGeneration);
            result = await (refreshed
              ? runOutsidePreparedModelRuntimePluginGenerationScope(() =>
                  runOutsidePluginRuntimeGenerationScope(run),
                )
              : run());
            const continuation = refresh.takeContinuation();
            if (refreshed || continuation) {
              mergeUsageIntoAccumulator(usage, result.meta.agentMeta?.usage);
              mergeAttemptRunStatsIntoAccumulator(usage, result.meta.agentMeta ?? {});
            }
            if (!continuation) {
              if (refreshed && result.meta.agentMeta) {
                result = {
                  ...result,
                  meta: {
                    ...result.meta,
                    durationMs: Date.now() - started,
                    agentMeta: {
                      ...result.meta.agentMeta,
                      usage: toNormalizedUsage(usage),
                      costUsd:
                        usage.cost && usage.cost !== "unavailable" ? usage.cost.total : undefined,
                      assistantTurns: usage.assistantTurns,
                      ...(usage.bridgeCalls ? { bridgeCalls: usage.bridgeCalls } : {}),
                    },
                  },
                };
              }
              failed = Boolean(result.meta.error) || result.meta.stopReason === "error";
              break;
            }
            // A refresh must join the old generation's tracked cleanup before reacquisition.
            await generationCleanup;
            // The old attempt has persisted results and released its tools. Reuse admission,
            // but acquire fresh plugin owners before continuing the same task from its transcript.
            params = continuation;
            refreshed = true;
          }
        } finally {
          // Error transcript and terminal publication belong to the logical run, not each generation.
          if (ownsAssistantErrorTranscript) {
            assistantErrorTranscript?.settle(failed && !params.abortSignal?.aborted);
          }
        }
        refresh.mergeTerminalReceipt(result);
        if (
          result.meta.executionTrace?.runner !== "cli" &&
          params.isFinalFallbackAttempt === undefined
        ) {
          await settleRequesterRun(params, result, () => {
            throwIfAborted();
            params.preparedRunAdmission?.assertSourceCurrent();
          });
        }
        const error = result.meta.error?.message ?? terminal?.getDeferredError();
        terminal?.emit(error ? "error" : "end", error ? new Error(error) : result, {
          ...resolveAgentLifecycleTerminalMetadata(result.meta),
          ...(result.meta.agentMeta?.terminalReceipt
            ? {
                assistantTranscriptIdempotencyKey:
                  result.meta.agentMeta.terminalReceipt.assistantTranscriptIdempotencyKey,
              }
            : {}),
        });
        return result;
      } catch (error) {
        // A fallback candidate is not the terminal owner, even if every later
        // candidate is skipped. The outer entry releases its children in that case.
        const failure =
          params.isFinalFallbackAttempt === undefined
            ? await settleFailedRequesterRun(
                params,
                error,
                // Internal loop stops end inference, not the parent's authority to
                // release its children. Parent cancellation and placement closure still fence it.
                resolveSessionPlacementTurnSettlementAssertion(),
              )
            : error;
        terminal?.emit("error", failure);
        throw failure;
      } finally {
        refresh.close();
      }
    });
  };
  return enqueueSession(() =>
    withExecRequestTurn(
      {
        identity: {
          runId: params.runId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          agentId: params.agentId,
        },
        owners: requestOwners,
        abortSignal: params.abortSignal,
      },
      runSession,
    ),
  ).finally(() => {
    revokeMessageActionTurnCapability(recoveryMessageActionTurnCapability);
  });
}
