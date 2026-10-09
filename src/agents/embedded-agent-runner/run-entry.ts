import { assertRequiredWorkerSelection } from "../../config/required-worker-profile.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  emitAgentEvent,
  emitAgentEventForRunContext,
} from "../../infra/agent-events.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { requireActivePluginRegistry } from "../../plugins/runtime.js";
import { mergeAcceptedSessionSpawnsForRun } from "../accepted-session-spawn.js";
import {
  readPreparedRunOperatorAuthority,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import {
  createAssistantErrorTranscript,
  type AssistantErrorTranscript,
} from "../assistant-error-transcript.js";
import { resolveModelFallbackError } from "../failover-error.js";
import { isFallbackCandidateSkipped } from "../fallback-skip-cache.js";
import {
  createContextEngineLogicalTurnLease,
  type ContextEngineLogicalTurnLease,
} from "../harness/context-engine-logical-turn.js";
import {
  finalizeAcceptedContextEngineTurn,
  type ContextEngineTurnAttemptFacts,
} from "../harness/context-engine-turn-attempt.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { selectAgentHarness } from "../harness/selection.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import { runWithModelFallback } from "../model-fallback-runner.js";
import type {
  FallbackAttempt,
  ModelFallbackAttemptProvenance,
  ModelFallbackRouteResolution,
} from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import { modelKey } from "../model-ref-shared.js";
import { settleFailedRequesterRun, settleRequesterRun } from "../requester-run-settlement.js";
import { resolveAgentRunAbortLifecycleFields } from "../run-termination.js";
import {
  resolveSessionPlacementRuntimeOverride,
  sessionPlacementUsesWorkerInference,
  withRequiredSessionPlacement,
} from "../session-placement-admission.js";
import {
  didEmbeddedCyberFailoverTargetCommitWork,
  EMBEDDED_CYBER_FAILOVER_TRIGGER_CODE,
  isEmbeddedCyberFailoverTargetUsable,
  isEmbeddedModelSelectionStrict,
  recordEmbeddedCyberFailoverTargetUnavailable,
  resolveEmbeddedCyberFailoverConfig,
  resolveEmbeddedCyberFailoverTarget,
} from "./embedded-cyber-failover.js";
import {
  classifyEmbeddedAgentRunResultForModelFallback,
  mergeEmbeddedAgentRunResultForModelFallbackExhaustion,
} from "./result-fallback-classifier.js";
import {
  buildRunEntryTerminal,
  canAdvanceContextEngineTurn,
  mergeRunEntryExecutionTrace,
  preserveFollowupResultForDelivery,
  resolveRunEntryTerminalOutcome,
  type EmbeddedAgentRunEntryTerminal,
  type RunEntryTerminalBehavior,
} from "./run-entry-terminal.js";
import { forgetPromptBuildDrainCacheForRun } from "./run/attempt-prompt-helpers.js";
import type { AuthProfileFailurePolicy } from "./run/auth-profile-failure-policy.types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export type { EmbeddedAgentRunEntryTerminal } from "./run-entry-terminal.js";

export type RunEntryCandidateOptions = {
  agentHarnessRuntimeOverride: string | undefined;
  assistantErrorTranscript: AssistantErrorTranscript;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  classifyResult: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  isFallbackRetry: boolean;
  modelRoutingProvenance: ModelFallbackAttemptProvenance;
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: (facts: ContextEngineTurnAttemptFacts) => void;
};

type RunEntryCandidate<T> = {
  result: T;
  classification?: ModelFallbackResultClassification;
  turnAttempt?: ContextEngineTurnAttemptFacts;
};

type RunEntryHarnessPreparation =
  | { kind: "direct" }
  | {
      kind: "measured";
      run: (prepare: () => Promise<void>) => Promise<void>;
    };

type RunEntrySessionOverride =
  | { kind: "preserve" }
  | {
      kind: "reconcile-completed";
      reconcile: (candidate: { provider: string; model: string }) => Promise<void>;
    };

type EmbeddedAgentRunEntryResult<T extends EmbeddedAgentRunResult> = {
  outcome: "completed" | "exhausted";
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  terminal: EmbeddedAgentRunEntryTerminal;
  settleSessionOverride: () => Promise<void>;
};

type EmbeddedAgentRunEntryParams<T extends EmbeddedAgentRunResult> = {
  preparedRunAdmission?: PreparedAgentRunAdmission;
  selection: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    requestedRouteResolution?: ModelFallbackRouteResolution;
    fallbacksOverride?: string[];
    agentDir?: string;
    userLockedAuthProfileId?: string;
  } & ModelManifestNormalizationContext;
  identity: {
    runId: string;
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    lane?: string;
  };
  harness: {
    workspaceDir: string;
    sessionKey?: string;
    preparation: RunEntryHarnessPreparation;
    resolveRuntimeOverride: (provider: string, model: string) => string | undefined;
    resolveContextEngineHost?: (
      provider: string,
      model: string,
      agentHarnessRuntimeOverride: string | undefined,
    ) => ContextEngineHostSupport | undefined;
  };
  behavior: RunEntryTerminalBehavior;
  sessionOverride: RunEntrySessionOverride;
  abortSignal?: AbortSignal;
  onFallbackStep?: (step: ModelFallbackStepFields) => void | Promise<void>;
  /** Runs once after the successful winner is accepted, before post-turn context commit. */
  onAcceptedTerminal?: () => void | (() => void) | Promise<void | (() => void)>;
  runCandidate: (provider: string, model: string, options: RunEntryCandidateOptions) => Promise<T>;
};

/** Runs one logical turn across model candidates and advances only the accepted winner. */
export async function runEmbeddedAgentEntry<T extends EmbeddedAgentRunResult>(
  params: EmbeddedAgentRunEntryParams<T>,
): Promise<EmbeddedAgentRunEntryResult<T>> {
  const admission = params.preparedRunAdmission;
  const requester = {
    ...params.identity,
    preparedRunAdmission: admission,
    abortSignal: params.abortSignal,
  };
  try {
    assertRequiredWorkerSelection(params.selection.cfg, {
      agentRuntime: params.harness.resolveRuntimeOverride(
        params.selection.provider,
        params.selection.model,
      ),
    });
    const result = await withRequiredSessionPlacement(
      params.identity,
      {
        config: params.selection.cfg,
        assertCurrent: () => admission?.assertSourceCurrent(),
        signal: params.abortSignal,
      },
      () => runEmbeddedAgentEntryInternal(params),
    );
    // Placement and asynchronous terminal cleanup have finished. Only this
    // accepted logical result may release children retained across candidates.
    await settleRequesterRun(requester, result.result, () => admission?.assertSourceCurrent());
    return result;
  } catch (error) {
    throw await settleFailedRequesterRun(requester, error);
  }
}

async function runEmbeddedAgentEntryInternal<T extends EmbeddedAgentRunResult>(
  params: EmbeddedAgentRunEntryParams<T>,
): Promise<EmbeddedAgentRunEntryResult<T>> {
  const operatorAuthority = readPreparedRunOperatorAuthority(params.preparedRunAdmission);
  const lifecycleGeneration = captureAgentRunLifecycleGeneration(params.identity.runId);
  const runContext = getAgentRunContext(params.identity.runId);
  const placementRuntime = await resolveSessionPlacementRuntimeOverride(params.identity);
  params.abortSignal?.throwIfAborted();
  params.preparedRunAdmission?.assertSourceCurrent();
  assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
  const harnessContext = (provider: string, modelId: string) => ({
    config: params.selection.cfg,
    provider,
    modelId,
    agentId: params.identity.agentId,
    sessionKey: params.harness.sessionKey,
  });
  const resolveRuntimeOverride = (provider: string, model: string) => {
    const requestedRuntime = params.harness.resolveRuntimeOverride(provider, model);
    assertRequiredWorkerSelection(params.selection.cfg, { agentRuntime: requestedRuntime });
    const policy = resolveAgentHarnessPolicy(harnessContext(provider, model));
    if (params.selection.cfg.cloudWorkers?.requiredProfile) {
      return policy.runtime;
    }
    return requestedRuntime || !placementRuntime
      ? requestedRuntime
      : policy.runtimeSource === "implicit"
        ? placementRuntime
        : undefined;
  };
  const clearObservedModel = () => {
    const event = {
      ...params.identity,
      lifecycleGeneration,
      stream: "lifecycle",
      data: { phase: "model", provider: null, model: null },
    } as const;
    if (runContext) {
      emitAgentEventForRunContext(event, runContext);
    } else {
      emitAgentEvent(event);
    }
  };
  const contextEngineLogicalTurnLease = await createContextEngineLogicalTurnLease({
    identity: params.identity,
    config: params.selection.cfg,
    agentDir: params.selection.agentDir,
    workspaceDir: params.harness.workspaceDir,
  });
  const assistantErrorTranscript = createAssistantErrorTranscript({
    runId: params.identity.runId,
    config: params.selection.cfg,
  });
  let failed = true;
  let candidateIndex = 0;
  const committedSideEffect =
    params.behavior.kind === "command-rpc" ? params.behavior.hasCommittedSideEffect : undefined;
  const readChannelDeliveryEvidence =
    params.behavior.kind === "channel-delivery" ? params.behavior.readDeliveryEvidence : undefined;
  const preparedHarnessRuntimes = new Set<string>();
  const prepareHarnessRuntime = async (candidate: {
    provider: string;
    model: string;
    agentHarnessRuntimeOverride?: string;
  }) => {
    assistantErrorTranscript.clear();
    const key = [
      candidate.provider,
      candidate.model,
      candidate.agentHarnessRuntimeOverride ?? "",
    ].join("\0");
    if (preparedHarnessRuntimes.has(key)) {
      return;
    }
    const prepare = () =>
      ensureSelectedAgentHarnessPlugin({
        ...harnessContext(candidate.provider, candidate.model),
        agentHarnessId: candidate.agentHarnessRuntimeOverride,
        agentHarnessRuntimeOverride: candidate.agentHarnessRuntimeOverride,
        workspaceDir: params.harness.workspaceDir,
        pluginRegistry: requireActivePluginRegistry(),
      });
    await (params.harness.preparation.kind === "measured"
      ? params.harness.preparation.run(prepare)
      : prepare());
    preparedHarnessRuntimes.add(key);
  };
  // Result classification and thrown errors must honor the same live delivery custody.
  const canFallback = committedSideEffect
    ? () => !committedSideEffect()
    : readChannelDeliveryEvidence
      ? () => {
          const evidence = readChannelDeliveryEvidence();
          return (
            !evidence.hasDirectlySentBlockReply &&
            !evidence.hasBlockReplyPipelineOutput &&
            !evidence.hasRetryBlockedDelivery
          );
        }
      : undefined;
  const hasCommittedSideEffect = canFallback ? () => !canFallback() : undefined;
  try {
    let capturedCyberRefusal: { provider: string; model: string } | undefined;
    const runFallbackSearch = (
      selection: EmbeddedAgentRunEntryParams<T>["selection"],
      runOptions: { captureCyberRefusal?: boolean; forceFallbackRetry?: boolean } = {},
    ) =>
      runWithModelFallback<RunEntryCandidate<T>>({
        ...selection,
        ...params.identity,
        operatorAuthority,
        skipAuthProfileRuntime: sessionPlacementUsesWorkerInference(params.identity),
        abortSignal: params.abortSignal,
        resolveAgentHarnessRuntimeOverride: resolveRuntimeOverride,
        prepareCandidateChain: async (candidates) => {
          for (const candidate of candidates) {
            try {
              const agentHarnessRuntimeOverride = resolveRuntimeOverride(
                candidate.provider,
                candidate.model,
              );
              await prepareHarnessRuntime({
                provider: candidate.provider,
                model: candidate.model,
                ...(agentHarnessRuntimeOverride ? { agentHarnessRuntimeOverride } : {}),
              });
              const resolvedHost = params.harness.resolveContextEngineHost?.(
                candidate.provider,
                candidate.model,
                agentHarnessRuntimeOverride,
              );
              const host =
                resolvedHost ??
                (() => {
                  const harness = selectAgentHarness({
                    ...harnessContext(candidate.provider, candidate.model),
                    agentHarnessRuntimeOverride,
                  });
                  return {
                    id: `agent-harness:${harness.id}`,
                    label: `agent harness "${harness.id}"`,
                    capabilities: harness.contextEngineHostCapabilities ?? [],
                  };
                })();
              contextEngineLogicalTurnLease.selectForHost({
                host,
                operation: "agent-run",
                requiresDurableCommit: false,
              });
            } catch {
              contextEngineLogicalTurnLease.degradeBeforeStart(
                "a model fallback candidate harness could not be validated before dispatch",
              );
              return;
            }
          }
        },
        prepareAgentHarnessRuntime: prepareHarnessRuntime,
        onFallbackStep: params.onFallbackStep,
        ...(params.behavior.kind === "maintenance"
          ? {}
          : {
              classifyResult: ({ result }: { result: RunEntryCandidate<T> }) =>
                result.result.meta.modelFallbackStopReason
                  ? { stopReason: result.result.meta.modelFallbackStopReason }
                  : canFallback?.() === false
                    ? undefined
                    : result.classification,
              mergeExhaustedResult: ({
                latestResult,
                preferredResult,
              }: {
                latestResult: RunEntryCandidate<T>;
                preferredResult: RunEntryCandidate<T>;
              }) => ({
                result: mergeEmbeddedAgentRunResultForModelFallbackExhaustion({
                  latestResult: latestResult.result,
                  preferredResult: preferredResult.result,
                }) as T,
                turnAttempt: latestResult.turnAttempt,
              }),
            }),
        ...(canFallback ? { canFallbackAfterError: canFallback } : {}),
        run: async (provider, model, options) => {
          assistantErrorTranscript.clear();
          if (!options) {
            throw new Error("Model fallback attempt is missing routing provenance");
          }
          const isFallbackRetry = runOptions.forceFallbackRetry === true || candidateIndex > 0;
          candidateIndex += 1;
          let contextEngineTurnCandidate: ContextEngineTurnAttemptFacts | undefined;
          let classified:
            | { result: EmbeddedAgentRunResult; value: ModelFallbackResultClassification }
            | undefined;
          const classifyResult = (result: EmbeddedAgentRunResult) => {
            // Custody can settle between classification and finalization; never cache its veto.
            if (canFallback?.() === false) {
              if (runOptions.captureCyberRefusal) {
                capturedCyberRefusal = undefined;
              }
              return undefined;
            }
            if (!classified || classified.result !== result) {
              if (params.preparedRunAdmission) {
                const accepted = mergeAcceptedSessionSpawnsForRun(
                  params.preparedRunAdmission.operationalRunInstance,
                  result.acceptedSessionSpawns,
                );
                if (accepted.length) {
                  result.acceptedSessionSpawns = accepted;
                }
              }
              const classification =
                params.behavior.kind === "maintenance"
                  ? undefined
                  : classifyEmbeddedAgentRunResultForModelFallback({
                      result,
                      provider,
                      model,
                      ...readChannelDeliveryEvidence?.(),
                    });
              const effectiveClassification =
                params.behavior.kind === "followup-delivery"
                  ? preserveFollowupResultForDelivery(classification)
                  : classification;
              const cyberRefusal =
                effectiveClassification &&
                "code" in effectiveClassification &&
                effectiveClassification.code === EMBEDDED_CYBER_FAILOVER_TRIGGER_CODE;
              if (runOptions.captureCyberRefusal) {
                // Finalization can replace the result; only its current classification
                // may authorize policy escalation.
                capturedCyberRefusal = cyberRefusal ? { provider, model } : undefined;
              }
              classified = {
                result,
                value:
                  runOptions.captureCyberRefusal && cyberRefusal
                    ? undefined
                    : effectiveClassification,
              };
            }
            return classified.value;
          };
          try {
            const result = await params.runCandidate(provider, model, {
              agentHarnessRuntimeOverride: resolveRuntimeOverride(provider, model),
              assistantErrorTranscript,
              // The original OpenAI refusal proves this turn's credential already
              // reached the provider. Keep a target-only entitlement rejection from
              // poisoning shared auth health for ordinary OpenAI model selection.
              ...(runOptions.forceFallbackRetry
                ? { authProfileFailurePolicy: "local" as const }
                : {}),
              classifyResult,
              allowTransientCooldownProbe: options.allowTransientCooldownProbe,
              isFinalFallbackAttempt: options.isFinalFallbackAttempt,
              isFallbackRetry,
              modelRoutingProvenance: runOptions.forceFallbackRetry
                ? {
                    ...options.modelRoutingProvenance,
                    stage: "fallback",
                    fallbackReason: "unknown",
                  }
                : options.modelRoutingProvenance,
              contextEngineLogicalTurnLease,
              onContextEngineTurnCandidate: (facts) => {
                contextEngineTurnCandidate = facts;
              },
            });
            return {
              result,
              classification: classifyResult(result),
              turnAttempt: contextEngineTurnCandidate,
            };
          } finally {
            clearObservedModel();
          }
        },
      });

    const originalFallbackResult = await runFallbackSearch(params.selection, {
      captureCyberRefusal: true,
    });
    const originalErrorTranscript = assistantErrorTranscript.snapshot();
    let fallbackResult = originalFallbackResult;
    let policyEscalated = false;
    const cyberFailover = resolveEmbeddedCyberFailoverConfig(params.selection.cfg);
    const target =
      capturedCyberRefusal && cyberFailover.mode === "auto"
        ? resolveEmbeddedCyberFailoverTarget({
            cfg: params.selection.cfg,
            agentId: params.identity.agentId,
            raw: cyberFailover.model,
            manifestPlugins: params.selection.manifestPlugins,
          })
        : null;
    const authScope = params.selection.userLockedAuthProfileId?.trim() || undefined;
    if (
      capturedCyberRefusal &&
      target &&
      (!operatorAuthority?.modelPolicy || operatorAuthority.modelPolicy.allows(target)) &&
      !isEmbeddedModelSelectionStrict(params.selection) &&
      modelKey(capturedCyberRefusal.provider, capturedCyberRefusal.model) !==
        modelKey(target.provider, target.model) &&
      !isFallbackCandidateSkipped({
        sessionId: params.identity.sessionId,
        provider: target.provider,
        model: target.model,
        authScope,
      })
    ) {
      const recordTargetUnavailable = (attempts: FallbackAttempt[]) =>
        recordEmbeddedCyberFailoverTargetUnavailable({
          sessionId: params.identity.sessionId,
          target,
          authScope,
          attempts,
          cooloffMs: cyberFailover.cooloffMs,
        });
      const restoreOriginalRefusal = () => {
        assistantErrorTranscript.restore(originalErrorTranscript);
        fallbackResult = {
          ...originalFallbackResult,
          result: { ...originalFallbackResult.result, turnAttempt: undefined },
        };
      };
      try {
        const targetFallbackResult = await runFallbackSearch(
          {
            ...params.selection,
            provider: target.provider,
            model: target.model,
            requestedRouteResolution: "resolved",
            fallbacksOverride: [],
          },
          { forceFallbackRetry: true },
        );
        const usable =
          targetFallbackResult.outcome === "completed" &&
          isEmbeddedCyberFailoverTargetUsable(targetFallbackResult.result.result);
        if (!usable) {
          recordTargetUnavailable(targetFallbackResult.attempts);
        }
        const targetResult = targetFallbackResult.result.result;
        // Retain cancellation or committed work even when the policy retry failed.
        if (
          usable ||
          targetResult.meta.aborted === true ||
          didEmbeddedCyberFailoverTargetCommitWork(targetResult) ||
          hasCommittedSideEffect?.() === true
        ) {
          policyEscalated = usable;
          fallbackResult = {
            ...targetFallbackResult,
            attempts: [
              ...originalFallbackResult.attempts,
              {
                provider: capturedCyberRefusal.provider,
                model: capturedCyberRefusal.model,
                error: "OpenAI cyber policy refusal",
                reason: "unknown",
                code: EMBEDDED_CYBER_FAILOVER_TRIGGER_CODE,
              },
              ...targetFallbackResult.attempts,
            ],
          };
        } else {
          restoreOriginalRefusal();
        }
      } catch (error) {
        const resolution = resolveModelFallbackError(error, {
          provider: target.provider,
          model: target.model,
          sessionId: params.identity.sessionId,
          lane: params.identity.lane,
        });
        // Only an ordinary provider failure with no committed work can restore the
        // original refusal. Terminal stops and coordination failures must propagate.
        if (resolution.kind !== "failover" || hasCommittedSideEffect?.() === true) {
          throw error;
        }
        if (resolution.error.reason === "auth" || resolution.error.reason === "auth_permanent") {
          recordTargetUnavailable([
            {
              provider: target.provider,
              model: target.model,
              error: resolution.error.message,
              reason: resolution.error.reason,
              code: resolution.error.code,
            },
          ]);
        }
        restoreOriginalRefusal();
      }
    }
    const abortFields =
      params.behavior.kind === "command-rpc"
        ? resolveAgentRunAbortLifecycleFields(params.abortSignal)
        : {};
    const candidateResult =
      abortFields.aborted === true
        ? ({
            ...fallbackResult.result.result,
            meta: {
              ...fallbackResult.result.result.meta,
              ...abortFields,
            },
          } as T)
        : fallbackResult.result.result;
    const outcome = fallbackResult.outcome;
    // A completed fallback search can still return a failed or interrupted run.
    const terminalOutcome = resolveRunEntryTerminalOutcome({
      result: candidateResult,
      fallbackExhausted: outcome === "exhausted",
    });
    failed = terminalOutcome.status === "error";
    const result = mergeRunEntryExecutionTrace({
      result: candidateResult,
      terminalStatus: terminalOutcome.status,
      provider: fallbackResult.provider,
      model: fallbackResult.model,
      requestedProvider: params.selection.provider,
      requestedModel: params.selection.model,
      fallbackAttempts: fallbackResult.attempts,
      ...(policyEscalated
        ? {
            providerPolicyRetry: {
              category: "cyber",
              provider: fallbackResult.provider,
              model: fallbackResult.model,
            } as const,
          }
        : {}),
    });
    const terminal = buildRunEntryTerminal({
      result,
      outcome: terminalOutcome,
      behavior: params.behavior,
      runId: params.identity.runId,
      requested: { provider: params.selection.provider, model: params.selection.model },
      sessionId: params.identity.sessionId,
    });
    const acceptedTerminal =
      !params.abortSignal?.aborted &&
      canAdvanceContextEngineTurn({
        result,
        fallbackOutcome: outcome,
        terminal,
      });
    const releaseAcceptedTerminalWork = acceptedTerminal
      ? await params.onAcceptedTerminal?.()
      : undefined;
    try {
      if (acceptedTerminal && fallbackResult.result.turnAttempt) {
        await finalizeAcceptedContextEngineTurn({
          config: params.selection.cfg,
          facts: fallbackResult.result.turnAttempt,
          lease: contextEngineLogicalTurnLease,
        });
      }
    } finally {
      if (typeof releaseAcceptedTerminalWork === "function") {
        releaseAcceptedTerminalWork();
      }
    }
    let sessionOverrideSettled = false;
    const settleSessionOverride = async () => {
      if (sessionOverrideSettled) {
        return;
      }
      sessionOverrideSettled = true;
      if (
        !policyEscalated &&
        outcome === "completed" &&
        params.sessionOverride.kind === "reconcile-completed"
      ) {
        await params.sessionOverride.reconcile({
          provider: fallbackResult.provider,
          model: fallbackResult.model,
        });
      }
    };
    return { ...fallbackResult, result, terminal, settleSessionOverride };
  } finally {
    forgetPromptBuildDrainCacheForRun(params.identity.runId);
    try {
      await assistantErrorTranscript.settle(failed && !params.abortSignal?.aborted);
    } finally {
      await contextEngineLogicalTurnLease.dispose();
    }
  }
}
