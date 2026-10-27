import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import { buildTerminalAgentRunFailureReplyPayload } from "../../auto-reply/reply/agent-runner-failure-reply.js";
import { applyModelRuntimeDirective } from "../../auto-reply/reply/directive-handling.model-runtime.js";
import { resolveSessionAuthProfileOverrideSource } from "../../config/sessions/auth-profile-override-provenance.js";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { clearAgentRunTerminalWriteContext } from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  buildAgentHookContextChannelFields,
  buildAgentHookContextIdentityFields,
} from "../../plugins/hook-agent-context.js";
import {
  MODEL_SELECTION_LOCKED_MESSAGE,
  ModelSelectionLockedError,
  isModelSelectionLocked,
} from "../../sessions/model-overrides.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import { resolveMessageChannel } from "../../utils/message-channel.js";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agent-run-terminal-outcome.js";
import {
  clearAutoFallbackPrimaryProbeSelection,
  entryMatchesAutoFallbackPrimaryProbe,
  markAutoFallbackPrimaryProbe,
} from "../agent-scope.js";
import { buildRunEntryTerminal } from "../embedded-agent-runner/run-entry-terminal.js";
import {
  runEmbeddedAgentEntry,
  type EmbeddedAgentRunEntryTerminal,
} from "../embedded-agent-runner/run-entry.js";
import { createDeferredEmbeddedRunLifecycleManager } from "../embedded-agent-runner/run/deferred-lifecycle-owner.js";
import { resolveFastModeState } from "../fast-mode.js";
import { prepareInternalSessionEffectsSession } from "../internal-session-effects.js";
import { LiveSessionModelSwitchError } from "../live-model-switch.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../media-generation-activity.js";
import { findModelInCatalog, prepareModelRunCapabilities } from "../model-catalog-lookup.js";
import { resolveEffectiveModelFallbacks } from "../model-selection-config.js";
import {
  resolveConfiguredThinkingDefault,
  resolveThinkingSelection,
} from "../model-thinking-default.js";
import { createModelVisibilityPolicy } from "../model-visibility-policy.js";
import { PreparedModelRuntimeInitialRunAdmissionError } from "../prepared-model-runtime.errors.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
  resolveAgentRunErrorLifecycleFields,
} from "../run-termination.js";
import { resolveSessionRuntimeOverrideForProvider } from "../session-runtime-compat.js";
import { measureAgentStartup } from "../startup-timing.js";
import {
  normalizeThinkingCatalogProviders,
  resolveEffectiveAgentRuntime,
} from "../thinking-runtime.js";
import {
  createAgentAttemptLifecycleCallbacks,
  resetAgentAttemptLifecycle,
  type AgentAttemptLifecycleState,
} from "./attempt-callbacks.js";
import { persistAgentSession } from "./attempt-execution.shared.js";
import { createCommandCompactionAccounting } from "./compaction-accounting.js";
import { createAgentCommandLifecycle } from "./lifecycle.js";
import { withCommandThinkingClamp } from "./model-selection.js";
import type { RunEmbeddedAgentAttemptParams } from "./run-embedded-attempt.types.js";
import { loadAttemptExecutionRuntime, type AgentAttemptResult } from "./runtime-loaders.js";
import {
  prepareCommandUserTurnTranscript,
  resolveInternalSessionEffectsSource,
} from "./session-helpers.js";
const log = createSubsystemLogger("agents/agent-command");
const MAX_LIVE_SWITCH_RETRIES = 5;

export async function runEmbeddedAgentAttempt(params: RunEmbeddedAgentAttemptParams) {
  const {
    cfg,
    body,
    transcriptBody,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    sessionAgentId,
    workspaceDir,
    cwd,
    agentDir,
    runId,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
    normalizedSpawned,
    isNewSession,
    timeoutMs,
    runTimeoutOverrideMs,
  } = params.prepared;
  const { runContext, skillsSnapshot, resolvedVerboseLevel } = params.embeddedSessionState;
  const {
    defaultProvider,
    defaultModel,
    configuredDefaultAuthProfileId,
    hasExplicitRunOverride,
    storedProviderOverride,
    hasStoredAutoFallbackProvenance,
    autoFallbackPrimaryProbe,
    immutableThinkLevel,
    sessionFile,
  } = params.modelSelection;
  let {
    provider,
    model,
    providerForAuthProfileValidation,
    sessionEntryForAttempt,
    storedModelOverride,
    storedModelOverrideSource,
    effectiveTurnThinkLevel,
  } = params.modelSelection;
  const thinkingCatalog = params.modelSelection.thinkingCatalog;
  let sessionEntry = params.sessionEntry;
  let lifecycleGeneration = params.lifecycleGeneration;

  const sessionEffectsSource = resolveInternalSessionEffectsSource({
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    storePath,
  });
  const internalSessionTarget = params.suppressVisibleSessionEffects
    ? await prepareInternalSessionEffectsSession({
        agentId: sessionAgentId,
        cwd: cwd ?? workspaceDir,
        runId,
        source: sessionEffectsSource,
        storePath,
      })
    : undefined;
  params.trackInternalModelRunTarget(internalSessionTarget);
  let attemptSessionTarget = internalSessionTarget ?? sessionEffectsSource;
  const attemptSessionFile = internalSessionTarget?.sessionFile ?? sessionFile;

  const startedAt = Date.now();
  const attemptLifecycleState: AgentAttemptLifecycleState = {
    lifecycleFinishing: false,
    lifecycleEnded: false,
  };
  let executionStarted = false;
  const attemptLifecycleCallbacks = createAgentAttemptLifecycleCallbacks(
    attemptLifecycleState,
    () => {
      executionStarted = true;
      return params.preparedRunAdmission.onRuntimeTurnStarted();
    },
  );
  const { suppressUserTurnPersistence, userTurnTranscriptRecorder } =
    prepareCommandUserTurnTranscript(params, internalSessionTarget, sessionEntry);
  const lifecycle = createAgentCommandLifecycle({
    runId,
    lifecycleGeneration: () => lifecycleGeneration,
    startedAt,
    abortSignal: params.opts.abortSignal,
    state: attemptLifecycleState,
  });
  const attemptExecutionRuntime = await measureAgentStartup(
    "attempt-runtime-import",
    () => loadAttemptExecutionRuntime(),
    { config: cfg },
  );
  const messageChannel = resolveMessageChannel(
    runContext.messageChannel,
    params.opts.replyChannel ?? params.opts.channel,
  );

  let result: AgentAttemptResult;
  const compactionAccounting = createCommandCompactionAccounting({
    sessionStore,
    persistCounts:
      !params.suppressVisibleSessionEffects && !params.preserveUserFacingSessionModelState,
    onDurableFact: (fact) => {
      attemptSessionTarget = fact.target;
      params.trackInternalModelRunTarget(fact.target);
      params.onCompactionAccounting?.(fact);
    },
    refreshSessionEntry: (key) => {
      sessionEntry = sessionStore?.[key] ?? sessionEntry;
      sessionEntryForAttempt = sessionEntry;
    },
  });
  let maintenanceAuthProfile:
    | { authProfileId?: string; authProfileIdSource?: "auto" | "user" }
    | undefined;
  let fallbackProvider = provider;
  let fallbackModel = model;
  let fallbackExhausted = false;
  let terminal: EmbeddedAgentRunEntryTerminal;
  let liveSwitchRetries = 0;
  let candidateAttempts = 0;
  let autoFallbackPrimaryProbeInterruptedByLiveSwitch = false;
  const fastModeStartedAtMs = Date.now();
  const assertTrajectoryCurrent = () => {
    params.opts.abortSignal?.throwIfAborted();
    params.preparedRunAdmission.assertSourceCurrent();
  };
  assertTrajectoryCurrent();
  const fallbackTrajectoryRecorder = await createTrajectoryRuntimeRecorder({
    cfg,
    runId,
    sessionId: attemptSessionTarget?.sessionId ?? sessionId,
    sessionKey: attemptSessionTarget?.sessionKey ?? sessionKey,
    sessionFile: attemptSessionFile,
    sessionTarget: attemptSessionTarget,
    assertCommitAllowed: assertTrajectoryCurrent,
    provider,
    modelId: model,
    workspaceDir,
  });
  assertTrajectoryCurrent();
  const deferredLifecycle = createDeferredEmbeddedRunLifecycleManager({
    runId,
    agentId: sessionAgentId,
    sessionId,
    sessionKey,
    sessionFile: attemptSessionFile,
    abortSignal: params.opts.abortSignal,
  });
  const logicalTurnOpts = { ...params.opts, abortSignal: deferredLifecycle.signal };
  let liveSwitchMediaTaskIds: ReadonlySet<string> = new Set();
  let attemptMediaTaskIds = liveSwitchMediaTaskIds;
  const currentAttemptCommittedCronMedia = () =>
    hasNewGeneratedMediaTaskForSessionKey(sessionKey, attemptMediaTaskIds, sessionAgentId);
  for (;;) {
    try {
      liveSwitchMediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(sessionKey, sessionAgentId);
      const spawnedBy = normalizedSpawned.spawnedBy ?? sessionEntry?.spawnedBy;
      const effectiveFallbacksOverride = isModelSelectionLocked(sessionEntry)
        ? []
        : (params.opts.modelFallbacksOverride ??
          resolveEffectiveModelFallbacks({
            cfg,
            agentId: sessionAgentId,
            sessionKey,
            selectedModel: { provider, model },
            hasSessionModelOverride:
              hasExplicitRunOverride || Boolean(storedProviderOverride || storedModelOverride),
            modelOverrideSource: hasExplicitRunOverride ? "user" : storedModelOverrideSource,
            subagentSpawnLineage: (sessionEntry?.spawnDepth ?? 0) > 0,
            hasAutoFallbackProvenance: hasExplicitRunOverride
              ? false
              : hasStoredAutoFallbackProvenance,
          }));

      const fallbackRuntimeState: { originRuntime?: "cli" | "embedded" } = {};
      attemptMediaTaskIds = liveSwitchMediaTaskIds;
      const fallbackResult = await runEmbeddedAgentEntry<AgentAttemptResult>({
        preparedRunAdmission: params.preparedRunAdmission,
        modelResolve: {
          prompt: body,
          images: params.opts.images,
          cwd,
          modelSelectionLocked: isModelSelectionLocked(sessionEntry),
          context: {
            trigger: "user",
            ...buildAgentHookContextChannelFields({
              ...runContext,
              sessionKey,
              messageChannel,
              messageProvider: params.opts.messageProvider ?? messageChannel,
              messageTo: params.opts.replyTo ?? params.opts.to,
              agentAccountId: runContext.accountId,
            }),
            ...buildAgentHookContextIdentityFields({ ...runContext, trigger: "user" }),
          },
        },
        selection: {
          cfg,
          provider,
          model,
          requestedRouteResolution: params.modelSelection.requestedRouteResolution,
          agentDir,
          fallbacksOverride: effectiveFallbacksOverride,
          cyberAccessProgram: sessionEntryForAttempt?.cyberAccessProgram,
          userLockedAuthProfileId:
            resolveSessionAuthProfileOverrideSource(sessionEntryForAttempt) === "user"
              ? sessionEntryForAttempt?.authProfileOverride
              : undefined,
          ...modelManifestContext,
        },
        identity: {
          runId,
          agentId: sessionAgentId,
          sessionId,
          sessionKey: sessionKey ?? sessionId,
          sessionLifecycleRevision: sessionEntry?.lifecycleRevision ?? null,
        },
        harness: {
          workspaceDir,
          sessionKey,
          preparation: { kind: "direct" },
          resolveRuntimeOverride: (candidateProvider) =>
            resolveSessionRuntimeOverrideForProvider({
              provider: candidateProvider,
              entry: sessionEntryForAttempt,
              cfg,
            }),
        },
        behavior: {
          kind: "command-rpc",
          hasCommittedSideEffect: currentAttemptCommittedCronMedia,
        },
        sessionOverride: {
          kind: "reconcile-completed",
          reconcile: async ({ provider: winnerProvider, model: winnerModel }) => {
            if (
              !autoFallbackPrimaryProbe ||
              autoFallbackPrimaryProbeInterruptedByLiveSwitch ||
              !sessionEntry ||
              !sessionStore ||
              !sessionKey ||
              isModelSelectionLocked(sessionEntry) ||
              params.suppressVisibleSessionEffects ||
              params.preserveUserFacingSessionModelState ||
              !entryMatchesAutoFallbackPrimaryProbe(sessionEntry, autoFallbackPrimaryProbe) ||
              winnerProvider !== autoFallbackPrimaryProbe.provider ||
              winnerModel !== autoFallbackPrimaryProbe.model
            ) {
              return;
            }
            const nextSessionEntry = { ...sessionEntry };
            clearAutoFallbackPrimaryProbeSelection(nextSessionEntry);
            sessionEntry = await persistAgentSession({
              agentId: sessionAgentId,
              sessionStore,
              sessionKey,
              storePath,
              initialEntry: sessionEntry,
              entry: nextSessionEntry,
              shouldPersist: (current) =>
                Boolean(
                  current &&
                  entryMatchesAutoFallbackPrimaryProbe(current, autoFallbackPrimaryProbe),
                ),
            });
          },
        },
        abortSignal: deferredLifecycle.signal,
        onFallbackStep: (step) => {
          emitAgentEvent({
            runId,
            lifecycleGeneration,
            ...(sessionKey ? { sessionKey } : {}),
            stream: "lifecycle",
            data: { phase: "fallback_step", ...step },
          });
          fallbackTrajectoryRecorder?.recordEvent("model.fallback_step", step);
        },
        runCandidate: async (providerOverride, modelOverride, runOptions) => {
          candidateAttempts += 1;
          clearAgentRunTerminalWriteContext(params.preparedRunAdmission.operationalRunInstance);
          const candidateAccounting = compactionAccounting.beginCandidate(deferredLifecycle.signal);
          maintenanceAuthProfile = undefined;
          attemptMediaTaskIds = getGeneratedMediaTaskIdsForSessionKey(sessionKey, sessionAgentId);
          resetAgentAttemptLifecycle(attemptLifecycleState);
          const isAutoFallbackPrimaryProbeCandidate =
            autoFallbackPrimaryProbe &&
            providerOverride === autoFallbackPrimaryProbe.provider &&
            modelOverride === autoFallbackPrimaryProbe.model;
          const attemptSessionEntry =
            autoFallbackPrimaryProbe &&
            providerOverride === autoFallbackPrimaryProbe.fallbackProvider &&
            !isAutoFallbackPrimaryProbeCandidate
              ? sessionEntry
              : sessionEntryForAttempt;
          if (isAutoFallbackPrimaryProbeCandidate) {
            markAutoFallbackPrimaryProbe({ probe: autoFallbackPrimaryProbe, sessionKey });
          }
          await params.opts.onActiveModelSelected?.({
            provider: providerOverride,
            model: modelOverride,
          });
          const fastModeState = resolveFastModeState({
            cfg,
            provider: providerOverride,
            model: modelOverride,
            agentId: sessionAgentId,
            sessionEntry,
          });
          const fastMode = params.opts.fastMode ?? fastModeState.requestMode;
          const configuredAuthProfileId =
            providerOverride === defaultProvider && modelOverride === defaultModel
              ? configuredDefaultAuthProfileId
              : undefined;
          const agentHarnessRuntimeOverride = runOptions.agentHarnessRuntimeOverride;
          const candidateRuntime =
            agentHarnessRuntimeOverride ??
            resolveEffectiveAgentRuntime({
              cfg,
              provider: providerOverride,
              modelId: modelOverride,
              agentId: sessionAgentId,
              sessionKey,
              sessionEntry: attemptSessionEntry,
            });
          const candidateConfiguredThinkLevel =
            immutableThinkLevel ??
            resolveConfiguredThinkingDefault({
              cfg,
              agentId: sessionAgentId,
              provider: providerOverride,
              model: modelOverride,
            });
          const changedCandidate =
            providerOverride !== params.modelSelection.provider ||
            modelOverride !== params.modelSelection.model;
          let candidateThinkingCatalog = changedCandidate
            ? (params.modelSelection.loadDeferredThinkingCatalog?.() ?? thinkingCatalog)
            : thinkingCatalog;
          if (
            pluginsEnabled &&
            (candidateConfiguredThinkLevel !== "off" || candidateRuntime !== "openclaw")
          ) {
            const { loadProviderScopedThinkingCatalog } =
              await import("../model-catalog.runtime.js");
            const runtimeCatalog = normalizeThinkingCatalogProviders(
              await loadProviderScopedThinkingCatalog({
                config: cfg,
                provider: providerOverride,
                model: modelOverride,
                agentRuntime: candidateRuntime,
                agentId: sessionAgentId,
                workspaceDir,
              }),
            );
            if (findModelInCatalog(runtimeCatalog, providerOverride, modelOverride)) {
              candidateThinkingCatalog = createModelVisibilityPolicy({
                cfg,
                catalog: runtimeCatalog,
                defaultProvider,
                defaultModel: { provider: defaultProvider, model: defaultModel },
                agentId: sessionAgentId,
                allowManifestNormalization: true,
                allowPluginNormalization: true,
                ...modelManifestContext,
              }).catalog;
            }
          }
          const { requestedLevel, level: candidateThinkLevel } = resolveThinkingSelection({
            cfg,
            agentId: sessionAgentId,
            provider: providerOverride,
            model: modelOverride,
            level: candidateConfiguredThinkLevel,
            catalog: candidateThinkingCatalog,
            agentRuntime: candidateRuntime,
          });
          effectiveTurnThinkLevel = candidateThinkLevel;
          try {
            const candidateResult = await attemptExecutionRuntime.runAgentAttempt({
              ...runOptions,
              preparedRunAdmission: params.preparedRunAdmission,
              providerOverride,
              modelOverride,
              ...prepareModelRunCapabilities(
                [candidateThinkingCatalog, params.prepared.configuredThinkingCatalog],
                [providerOverride, modelOverride, candidateRuntime],
              ),
              configuredAuthProfileId: runOptions.authProfileId ?? configuredAuthProfileId,
              modelFallbacksOverride: runOptions.modelFallbacksOverride,
              originalProvider: provider,
              cfg,
              sessionEntry: attemptSessionEntry,
              sessionId: attemptSessionTarget?.sessionId ?? sessionId,
              sessionKey,
              ...(attemptSessionTarget ? { sessionTarget: attemptSessionTarget } : {}),
              sessionAgentId,
              sessionFile: attemptSessionFile,
              workspaceDir,
              cwd,
              body,
              transcriptBody,
              preserveCliSessionBinding: params.preserveUserFacingSessionModelState,
              resolvedThinkLevel: candidateThinkLevel,
              thinkingExplicit: candidateConfiguredThinkLevel !== undefined,
              fastMode,
              fastModeStartedAtMs,
              fastModeAutoOnSeconds:
                fastMode === "auto"
                  ? (params.opts.fastModeAutoOnSeconds ?? fastModeState.fastAutoOnSeconds)
                  : fastModeState.fastAutoOnSeconds,
              timeoutMs,
              runTimeoutOverrideMs,
              runId,
              lifecycleGeneration,
              opts: logicalTurnOpts,
              runContext,
              spawnedBy,
              messageChannel,
              skillsSnapshot,
              resolvedVerboseLevel,
              agentDir,
              authProfileProvider: providerForAuthProfileValidation,
              sessionStore: params.suppressVisibleSessionEffects ? undefined : sessionStore,
              storePath: params.suppressVisibleSessionEffects ? undefined : storePath,
              pluginsEnabled,
              ...(manifestMetadataSnapshot ? { metadataSnapshot: manifestMetadataSnapshot } : {}),
              pluginGeneration: params.prepared.commandRuntimeContext?.pluginGeneration,
              sessionHasHistory:
                !isNewSession ||
                (await attemptExecutionRuntime.sessionTranscriptHasContent(
                  attemptSessionTarget,
                  deferredLifecycle.signal,
                )),
              fallbackRuntimeState,
              suppressPromptPersistenceOnRetry:
                suppressUserTurnPersistence ||
                userTurnTranscriptRecorder.hasPersisted() ||
                userTurnTranscriptRecorder.isBlocked(),
              userTurnTranscriptRecorder,
              onCompactionAccounting: candidateAccounting.observe,
              onCompactionRequestBudget: candidateAccounting.observeRequestBudget,
              onSuccessfulAuthProfile: (selection) => {
                // Absence is a valid ambient-auth result; only an uncalled observer is unknown.
                maintenanceAuthProfile = selection;
              },
              onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
                lifecycleGeneration = nextLifecycleGeneration;
                params.onLifecycleGenerationChanged(nextLifecycleGeneration);
              },
              onAgentEvent: attemptLifecycleCallbacks.onAgentEvent,
              onAttemptStart: attemptLifecycleCallbacks.onAttemptStart,
              onAttemptTerminalReplaced: attemptLifecycleCallbacks.onAttemptTerminalReplaced,
              deferTerminalLifecycle: true,
              deferredLifecycle,
            });
            return withCommandThinkingClamp(candidateResult, {
              requestedLevel,
              candidateThinkLevel,
              provider: providerOverride,
              model: modelOverride,
            });
          } finally {
            await candidateAccounting.finish(sessionEntry);
          }
        },
      });
      result = fallbackResult.result;
      terminal = fallbackResult.terminal;
      if (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason)) {
        throw params.opts.abortSignal?.reason;
      }
      // The embedded runtime can settle before the command's outer signal is aborted.
      if (terminal.outcome.stopReason === AGENT_RUN_RESTART_ABORT_STOP_REASON) {
        throw createAgentRunRestartAbortError();
      }
      fallbackProvider = fallbackResult.provider;
      fallbackModel = fallbackResult.model;
      fallbackExhausted = fallbackResult.outcome === "exhausted";
      await fallbackResult.settleSessionOverride();
      if (fallbackResult.attempts.length > 0 && result.meta.agentMeta) {
        result.meta.agentMeta.fallbackAttempts = fallbackResult.attempts;
      }
      if (!fallbackExhausted) {
        lifecycle.emitFinishing(terminal);
      }
      break;
    } catch (caught) {
      let err = caught;
      if (
        err instanceof PreparedModelRuntimeInitialRunAdmissionError &&
        candidateAttempts === 1 &&
        params.opts.deliver === true &&
        !params.suppressVisibleSessionEffects
      ) {
        try {
          assertTrajectoryCurrent();
          deferredLifecycle.signal.throwIfAborted();
          // Keep the execution failed, but give normal finalization custody of its
          // visible failure notice and receipt before the recovery claim is retired.
          attemptLifecycleState.lifecycleError = err.message;
          result = {
            payloads: [
              buildTerminalAgentRunFailureReplyPayload({
                replyExpectation: "required",
                visibleReplyDelivered: false,
              }),
            ],
            meta: {
              durationMs: Date.now() - startedAt,
              stopReason: "error",
              providerStarted: false,
            },
          };
          terminal = buildRunEntryTerminal({
            result,
            outcome: buildAgentRunTerminalOutcomeFromLifecycleEvent({
              phase: "error",
              data: { ...result.meta, error: err.message },
            }),
            behavior: {
              kind: "command-rpc",
              hasCommittedSideEffect: currentAttemptCommittedCronMedia,
            },
            runId,
            requested: { provider, model },
            sessionId,
          });
          lifecycle.emitFinishing(terminal);
          break;
        } catch (admissionError) {
          err = admissionError;
        }
      }
      if (err instanceof LiveSessionModelSwitchError) {
        if (isModelSelectionLocked(sessionEntry)) {
          lifecycle.emitBasicError(MODEL_SELECTION_LOCKED_MESSAGE);
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new ModelSelectionLockedError();
        }
        if (
          hasNewGeneratedMediaTaskForSessionKey(sessionKey, liveSwitchMediaTaskIds, sessionAgentId)
        ) {
          await deferredLifecycle.complete();
          throw err;
        }
        liveSwitchRetries += 1;
        if (liveSwitchRetries > MAX_LIVE_SWITCH_RETRIES) {
          const retryLimitMessage = `Exceeded maximum live model switch retries (${MAX_LIVE_SWITCH_RETRIES})`;
          log.error(`Live session model switch in subagent run ${runId}: ${retryLimitMessage}`);
          lifecycle.emitBasicError("Agent run failed");
          await fallbackTrajectoryRecorder?.flush();
          await deferredLifecycle.complete();
          throw new Error(retryLimitMessage, { cause: caught });
        }
        // The session writer already admitted this selection; retrying does not make a new choice.
        if (storedModelOverride || err.model !== model || err.provider !== provider) {
          storedModelOverride = err.model;
          storedModelOverrideSource = "user";
        }
        if (autoFallbackPrimaryProbe) {
          autoFallbackPrimaryProbeInterruptedByLiveSwitch = true;
        }
        provider = err.provider;
        model = err.model;
        providerForAuthProfileValidation = err.provider;
        if (sessionEntry) {
          sessionEntry = { ...sessionEntry };
          applyModelRuntimeDirective(
            sessionEntry,
            err.agentRuntimeOverride
              ? { kind: "set", runtime: err.agentRuntimeOverride }
              : { kind: "clear" },
          );
          sessionEntry.authProfileOverride = err.authProfileId;
          sessionEntry.authProfileOverrideSource = err.authProfileId
            ? err.authProfileIdSource
            : undefined;
          sessionEntry.authProfileOverrideCompactionCount = undefined;
          sessionEntryForAttempt = sessionEntry;
        }
        attemptLifecycleState.lifecycleEnded = false;
        log.info(
          `Live session model switch in subagent run ${runId}: switching to ${sanitizeForLog(err.provider)}/${sanitizeForLog(err.model)}`,
        );
        continue;
      }
      const errorLifecycleFields = resolveAgentRunErrorLifecycleFields(
        err,
        params.opts.abortSignal,
      );
      lifecycle.emitBasicError(err instanceof Error ? err : new Error("Agent run failed"), {
        ...errorLifecycleFields,
        ...(!executionStarted ? { executionStarted: false, providerStarted: false } : {}),
      });
      await fallbackTrajectoryRecorder?.flush();
      await deferredLifecycle.complete();
      throw err;
    }
  }

  return {
    startedAt,
    result,
    fallbackProvider,
    fallbackModel,
    fallbackExhausted,
    provider,
    model,
    sessionEntry,
    lifecycleGeneration,
    effectiveTurnThinkLevel,
    maintenanceAuthProfile,
    compactionAccounting: compactionAccounting.fact,
    compactionRequestBudget: compactionAccounting.requestBudget,
    internalSessionTarget,
    attemptExecutionRuntime,
    messageChannel,
    suppressUserTurnPersistence,
    userTurnTranscriptRecorder,
    fallbackTrajectoryRecorder,
    deferredLifecycle,
    lifecycle,
    terminal,
  };
}
