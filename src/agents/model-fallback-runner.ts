import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitFailoverEvent } from "../infra/diagnostic-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import {
  assertAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { externalCliDiscoveryScoped } from "./auth-profiles/external-cli-discovery.js";
import { resolveSubscriptionAuthModeForProfiles } from "./auth-profiles/profile-list.js";
import { hasAnyAuthProfileStoreSource } from "./auth-profiles/source-check.js";
import {
  FailoverError,
  buildProviderReauthCommand,
  coerceToFailoverError,
  describeFailoverError,
  hasProviderRequestSizeCeiling,
  isFailoverError,
  isNonProviderRuntimeCoordinationError,
} from "./failover-error.js";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";
import type { FailoverReason } from "./failover/signal.js";
import {
  getFallbackCandidateSkipReason,
  isFallbackCandidateSkipped,
  markFallbackCandidateSkipped,
} from "./fallback-skip-cache.js";
import {
  isAgentHarnessPreflightError,
  isMissingAgentHarnessError,
  resolveAgentHarnessPreflightOwner,
} from "./harness/errors.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
import {
  appendFailedCandidateAttempt,
  hasDifferentLiveSessionRuntimeSelection,
  isTranscriptNotContinuableError,
  type ModelFallbackAuthRuntime,
  type ModelFallbackClassifiedResult,
  type ModelFallbackErrorHandler,
  type ModelFallbackExhaustionResult,
  type ModelFallbackResultClassifier,
  type ModelFallbackRunFn,
  type ModelFallbackRunOptions,
  type ModelFallbackRunResult,
  type ModelFallbackRuntimeContext,
  type ModelFallbackStepHandler,
  recordFailedCandidateAttempt,
  resolveFallbackAuthScope,
  resolveFallbackSoonestCooldownExpiry,
  resolveLiveSessionModelSwitchRedirectIndex,
  resolveModelFallbackCandidateAgentRuntime,
  resolveModelFallbackCandidateHarnessAuthPrecheck,
  resolveNextFallbackCandidateIndex,
  runFallbackAttempt,
  shouldDiscardDeferredSessionSuspension,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import {
  markProbeAttempt,
  resolveCooldownDecision,
  resolveProbeThrottleKey,
} from "./model-fallback-cooldown.js";
import {
  isModelFallbackDecisionLogEnabled,
  logModelFallbackDecision,
  type ModelFallbackDecisionParams,
} from "./model-fallback-observation.js";
import {
  MODEL_FALLBACK_SKIPPED_CODE,
  type FallbackAttempt,
  type ModelFallbackCandidate,
  type ModelFallbackRouteResolution,
} from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  resolveSessionSuspensionReason,
  suspendSession,
  type SessionSuspensionParams,
} from "./session-suspension.js";

const log = createSubsystemLogger("model-fallback");
const modelFallbackAuthRuntimeLoader = createLazyImportLoader<ModelFallbackAuthRuntime>(
  () => import("./auth-profiles.runtime.js"),
);

type RunWithModelFallbackParams<T> = ModelFallbackRuntimeContext & {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  sessionId?: string;
  userLockedAuthProfileId?: string;
  prepareCandidateChain?: (candidates: readonly ModelFallbackCandidate[]) => Promise<void> | void;
  lane?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  requestedRouteResolution?: ModelFallbackRouteResolution;
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
  onFallbackStep?: ModelFallbackStepHandler;
  classifyResult?: ModelFallbackResultClassifier<T>;
  /** Return false when a thrown attempt committed work that must not be replayed. */
  canFallbackAfterError?: (
    attempt: Parameters<ModelFallbackErrorHandler>[0],
  ) => boolean | Promise<boolean>;
  mergeExhaustedResult?: (params: { latestResult: T; preferredResult: T }) => T;
  skipAuthProfileRuntime?: boolean;
  abortSignal?: AbortSignal;
  operatorAuthority?: AdmittedRunOperatorAuthority;
} & ModelManifestNormalizationContext;

type DeferredSessionSuspensionState = {
  pending?: SessionSuspensionParams;
};

function flushDeferredSessionSuspension(state: DeferredSessionSuspensionState): void {
  const pending = state.pending;
  if (!pending) {
    return;
  }
  state.pending = undefined;
  void suspendSession(pending);
}

export async function runWithModelFallback<T>(
  params: RunWithModelFallbackParams<T>,
): Promise<ModelFallbackRunResult<T>> {
  const deferredSuspension: DeferredSessionSuspensionState = {};
  try {
    const result = await runWithModelFallbackInternal(params, deferredSuspension);
    if (result.outcome === "exhausted") {
      flushDeferredSessionSuspension(deferredSuspension);
    }
    return result;
  } catch (err) {
    if (!shouldDiscardDeferredSessionSuspension({ error: err, abortSignal: params.abortSignal })) {
      flushDeferredSessionSuspension(deferredSuspension);
    }
    throw err;
  }
}

async function runWithModelFallbackInternal<T>(
  params: RunWithModelFallbackParams<T>,
  deferredSuspension: DeferredSessionSuspensionState,
): Promise<ModelFallbackRunResult<T>> {
  const operatorAuthority = params.operatorAuthority;
  if (operatorAuthority) {
    assertAdmittedRunOperatorAuthority(operatorAuthority);
    operatorAuthority.assertCurrent();
  }
  const plannedCandidates = resolveModelCandidateChain({
    cfg: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
    requestedRouteResolution: params.requestedRouteResolution,
    manifestPlugins: params.manifestPlugins,
  });
  const operatorModelPolicy = operatorAuthority?.modelPolicy;
  const candidates = operatorModelPolicy
    ? plannedCandidates.filter(operatorModelPolicy.allows)
    : plannedCandidates;
  if (operatorModelPolicy && candidates.length === 0) {
    assertOperatorModelAllowed(operatorAuthority, undefined);
  }
  await params.prepareCandidateChain?.(candidates);
  const userLockedAuthProfileId = params.userLockedAuthProfileId?.trim() || undefined;
  const authRuntime =
    !params.skipAuthProfileRuntime &&
    params.cfg &&
    (userLockedAuthProfileId || hasAnyAuthProfileStoreSource(params.agentDir))
      ? await modelFallbackAuthRuntimeLoader.load()
      : null;
  const authStore = authRuntime
    ? authRuntime.ensureAuthProfileStore(params.agentDir, {
        profileId: userLockedAuthProfileId,
        externalCli: externalCliDiscoveryScoped({
          config: params.cfg,
          allowKeychainPrompt: false,
          providerIds: candidates.map((candidate) => candidate.provider),
          ...(userLockedAuthProfileId ? { profileIds: [userLockedAuthProfileId] } : {}),
        }),
      })
    : null;
  const attempts: FallbackAttempt[] = [];
  const profileIdsByCandidate = new Map<ModelFallbackCandidate, string[]>();
  let lastError: unknown;
  let latestClassifiedResult: ModelFallbackClassifiedResult<T> | undefined;
  let exhaustionResult: ModelFallbackExhaustionResult<T> | undefined;
  const cooldownProbeUsedProviders = new Set<string>();
  const tlsFailedProviders = new Set<string>();
  const notifyFallbackStep: ModelFallbackStepHandler = async (step) => {
    // Observations cannot replace candidate outcomes or stop a usable fallback.
    // Policy-bearing callbacks such as onError retain their own failure semantics.
    try {
      await params.onFallbackStep?.(step);
    } catch {
      log.warn("Model fallback observer failed; preserving execution outcome.");
    }
  };
  const observeDecision = async (decision: ModelFallbackDecisionParams) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      return;
    }
    const fallbackStep = logModelFallbackDecision(decision);
    if (fallbackStep) {
      await notifyFallbackStep(fallbackStep);
    }
  };
  const observeFailedCandidate = async (
    failedAttempt: Parameters<typeof recordFailedCandidateAttempt>[0],
  ) => {
    if (!params.onFallbackStep && !isModelFallbackDecisionLogEnabled()) {
      appendFailedCandidateAttempt(failedAttempt);
    } else {
      const fallbackStep = recordFailedCandidateAttempt(failedAttempt);
      if (fallbackStep) {
        await notifyFallbackStep(fallbackStep);
      }
    }
    // Emit only real candidate-to-candidate transitions. Terminal candidates
    // have no destination; cooldown suspension has its own diagnostic path.
    if (params.sessionId && failedAttempt.nextCandidate) {
      const described = describeFailoverError(failedAttempt.error);
      emitFailoverEvent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        lane: params.lane,
        fromProvider: failedAttempt.candidate.provider,
        fromModel: failedAttempt.candidate.model,
        toProvider: failedAttempt.nextCandidate.provider,
        toModel: failedAttempt.nextCandidate.model,
        reason: described.reason ?? "unknown",
        cascadeDepth: failedAttempt.attempt - 1,
        suspended: false,
      });
    }
  };

  const hasFallbackCandidates = candidates.length > 1;
  const requestedCandidate = candidates.find((candidate) => candidate.routeOrigin === "requested");
  const runAttribution = { sessionId: params.sessionId, lane: params.lane };
  const runObs = {
    runId: params.runId,
    ...runAttribution,
    requestedProvider: params.provider,
    requestedModel: params.model,
    fallbackConfigured: hasFallbackCandidates,
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates.at(i);
    if (!candidate) {
      throw new Error(`Missing model fallback candidate at index ${i}`);
    }
    if (tlsFailedProviders.has(candidate.provider)) {
      continue;
    }
    const candidateRef = { provider: candidate.provider, model: candidate.model };
    operatorAuthority?.assertCurrent();
    if (operatorAuthority?.modelPolicy?.allows(candidateRef) === false) {
      continue;
    }
    const nextCandidateIndex = resolveNextFallbackCandidateIndex({
      candidates,
      currentIndex: i,
      excludedProviders: tlsFailedProviders,
    });
    const nextCandidate = candidates[nextCandidateIndex];
    const hasRemainingCandidate = nextCandidate !== undefined;
    const candidateHarnessAuth = await resolveModelFallbackCandidateHarnessAuthPrecheck({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
      prepareAgentHarnessRuntime: params.prepareAgentHarnessRuntime,
      ...candidate,
    });
    const isPrimary = candidate.routeOrigin === "requested";
    const requestedModel =
      requestedCandidate !== undefined &&
      candidate.provider === requestedCandidate.provider &&
      candidate.model === requestedCandidate.model;
    const attemptContext = { attempt: i + 1, total: candidates.length };
    const candObs = {
      ...runObs,
      candidate,
      ...attemptContext,
      nextCandidate,
      isPrimary,
      requestedModelMatched: requestedModel,
    };
    const observeCandidateDecision = (
      decision: ModelFallbackDecisionParams["decision"],
      extra: Partial<ModelFallbackDecisionParams> = {},
    ) => observeDecision({ decision, ...candObs, ...extra });
    const pushSkippedAttempt = (error: string, reason: FailoverReason, authMode?: string) =>
      attempts.push({
        ...candidateRef,
        error,
        reason,
        code: MODEL_FALLBACK_SKIPPED_CODE,
        authMode,
      });
    const recordFailure = async (error: unknown, next: ModelFallbackCandidate | undefined) => {
      await observeFailedCandidate({ attempts, ...candObs, error, nextCandidate: next });
      await params.onError?.({ ...candidateRef, error, ...attemptContext });
    };

    let candidateAuthProfileIds: string[] | undefined;
    let quotaRequiresAuthPreparation = false;
    let userLockedAuthProfileEligible = false;
    if (authRuntime && authStore) {
      userLockedAuthProfileEligible =
        userLockedAuthProfileId !== undefined &&
        authRuntime.resolveAuthProfileEligibility({
          cfg: params.cfg,
          store: authStore,
          provider: candidate.provider,
          profileId: userLockedAuthProfileId,
          includePendingOAuthRefresh: true,
        }).eligible;
      let profileIds = authRuntime.resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
        forModel: candidate.model,
        includePendingOAuthRefresh: true,
      });
      if (userLockedAuthProfileEligible && userLockedAuthProfileId) {
        profileIds = [...new Set([userLockedAuthProfileId, ...profileIds])];
      }
      const quota = await authRuntime.maybeReprobeWhamBlockedProfiles({
        store: authStore,
        profileIds,
        agentDir: params.agentDir,
        cfg: params.cfg,
        forModel: candidate.model,
      });
      // Normal auth selection owns remaining profiles and declared direct credentials.
      quotaRequiresAuthPreparation = quota?.requiresAuthPreparation === true;
      if (!candidateHarnessAuth.skipsProviderAuthCooldown) {
        candidateAuthProfileIds = profileIds;
        profileIdsByCandidate.set(candidate, candidateAuthProfileIds);
      }
    }
    const candidateAuthScope = resolveFallbackAuthScope({
      userLockedAuthProfileId: userLockedAuthProfileEligible ? userLockedAuthProfileId : undefined,
      profileIds: candidateAuthProfileIds,
    });

    // Suppress repeated auth failures for fallbacks; explicit primaries still report their error.
    if (!isPrimary && params.sessionId) {
      const skipped = isFallbackCandidateSkipped({
        sessionId: params.sessionId,
        ...candidateRef,
        authScope: candidateAuthScope,
      });
      if (skipped) {
        const skipReason =
          getFallbackCandidateSkipReason({
            sessionId: params.sessionId,
            ...candidateRef,
            authScope: candidateAuthScope,
          }) ?? "auth";
        const reauthCommand = buildProviderReauthCommand(candidate.provider);
        const reauthHint = reauthCommand
          ? `run \`${reauthCommand}\` to re-authenticate`
          : "re-authenticate that provider";
        const error = `Skipping ${candidate.provider}/${candidate.model}: recent ${skipReason} failure in this session (${reauthHint})`;
        pushSkippedAttempt(error, skipReason as FailoverReason);
        await observeCandidateDecision("skip_candidate", {
          reason: skipReason as FailoverReason,
          error,
        });
        continue;
      }
    }

    let runOptions: Pick<ModelFallbackRunOptions, "allowTransientCooldownProbe"> | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    if (
      authRuntime &&
      authStore &&
      candidateAuthProfileIds &&
      !quotaRequiresAuthPreparation &&
      !candidateHarnessAuth.skipsProviderAuthCooldown
    ) {
      const profileIds = candidateAuthProfileIds;
      const isAnyProfileAvailable = profileIds.some(
        (id) => !authRuntime.isProfileInCooldown(authStore, id, undefined, candidate.model),
      );

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const decision = resolveCooldownDecision({
          candidate,
          isPrimary,
          requestedModel,
          hasFallbackCandidates,
          now,
          probeThrottleKey,
          authRuntime,
          authStore,
          profileIds,
        });
        const authMode =
          decision.reason === "billing" ||
          decision.reason === "auth" ||
          decision.reason === "auth_permanent" ||
          decision.reason === "session_expired"
            ? resolveSubscriptionAuthModeForProfiles({ store: authStore, profileIds })
            : undefined;

        if (decision.type !== "attempt") {
          const error =
            decision.type === "skip"
              ? decision.error
              : `Provider ${candidate.provider} is in cooldown`;
          pushSkippedAttempt(error, decision.reason, authMode);

          // Only record terminal session suspension when no remaining candidate
          // can serve the turn. Provider cooldown state prevents repeat probes.
          if (decision.type === "suspend_session" && params.sessionId) {
            emitFailoverEvent({
              sessionId: params.sessionId,
              lane: params.lane,
              fromProvider: candidate.provider,
              fromModel: candidate.model,
              reason: decision.reason,
              suspended: !hasRemainingCandidate,
            });
            if (!hasRemainingCandidate) {
              deferredSuspension.pending = undefined;
              void suspendSession({
                cfg: params.cfg,
                agentId: params.agentId,
                agentDir: params.agentDir,
                sessionId: params.sessionId,
                reason: resolveSessionSuspensionReason(decision.reason),
                failedProvider: candidate.provider,
                failedModel: candidate.model,
              });
            }
          }

          await observeCandidateDecision("skip_candidate", {
            reason: decision.reason,
            error,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.markProbe) {
          markProbeAttempt(now, probeThrottleKey);
        }
        if (shouldAllowCooldownProbeForReason(decision.reason)) {
          // Same-provider siblings share one transient cooldown probe per run.
          const isTransientCooldownReason = shouldUseTransientCooldownProbeSlot(decision.reason);
          if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
            const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
            pushSkippedAttempt(error, decision.reason, authMode);
            await observeCandidateDecision("skip_candidate", {
              reason: decision.reason,
              error,
              profileCount: profileIds.length,
            });
            continue;
          }
          runOptions = { allowTransientCooldownProbe: true };
          if (isTransientCooldownReason) {
            transientProbeProviderForAttempt = candidate.provider;
          }
        }
        attemptedDuringCooldown = true;
        await observeCandidateDecision("probe_cooldown_candidate", {
          reason: decision.reason,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          profileCount: profileIds.length,
        });
      }
    }

    operatorAuthority?.assertCurrent();
    if (operatorAuthority?.modelPolicy?.allows(candidateRef) === false) {
      continue;
    }
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      captureHarnessPreflight: true,
      options: {
        ...runOptions,
        isFinalFallbackAttempt: !hasRemainingCandidate,
        modelRoutingProvenance: {
          requestedProvider: params.provider,
          requestedModel: params.model,
          stage: isPrimary ? "initial" : "fallback",
          fallbackReason: isPrimary ? undefined : attempts.at(-1)?.reason,
        },
      },
      // Keep the lane available while the outer loop still has another candidate.
      deferSessionSuspension: hasRemainingCandidate,
      onDeferredSessionSuspension: (suspension) => {
        deferredSuspension.pending = suspension;
      },
      classifyResult: params.classifyResult,
      ...attemptContext,
      attribution: runAttribution,
      abortSignal: params.abortSignal,
    });
    if ("success" in attemptRun) {
      if (!attemptRun.stopped && (i > 0 || attempts.length > 0 || attemptedDuringCooldown)) {
        await observeCandidateDecision("candidate_succeeded", {
          previousAttempts: attempts,
        });
        const notFoundAttempt =
          i > 0 ? attempts.find((a) => a.reason === "model_not_found") : undefined;
        if (notFoundAttempt) {
          log.warn(
            `Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`,
          );
        }
      }
      return attemptRun.success;
    }
    const err = attemptRun.error;
    if (isAgentHarnessPreflightError(err)) {
      const failedHarnessId = resolveAgentHarnessPreflightOwner(err);
      if (!failedHarnessId) {
        // Pre-scope callers established that their preflight is global to the
        // fallback chain. Keep that public contract until they declare an owner.
        throw err;
      }
      let nextEligibleIndex = candidates.length;
      for (let index = i + 1; index < candidates.length; index += 1) {
        const next = candidates[index];
        if (!next || tlsFailedProviders.has(next.provider)) {
          continue;
        }
        const nextRuntime = resolveModelFallbackCandidateAgentRuntime({
          cfg: params.cfg,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
          ...next,
        }).runtime;
        // An unresolved runtime remains eligible: only suppress candidates
        // proven to repeat the exact harness-local failure.
        if (nextRuntime !== failedHarnessId) {
          nextEligibleIndex = index;
          break;
        }
      }
      const nextEligibleCandidate = candidates[nextEligibleIndex];
      if (!nextEligibleCandidate) {
        throw err;
      }
      lastError = err;
      await recordFailure(err, nextEligibleCandidate);
      // The selected candidate still enters its canonical admission path.
      i = nextEligibleIndex - 1;
      continue;
    }
    if (
      !attemptRun.classifiedResult &&
      params.canFallbackAfterError &&
      !(await params.canFallbackAfterError({
        ...candidateRef,
        error: err,
        ...attemptContext,
      }))
    ) {
      throw err;
    }
    if (attemptRun.classifiedResult) {
      latestClassifiedResult = attemptRun.classifiedResult;
    }
    if (
      attemptRun.exhaustionResult &&
      (!exhaustionResult || attemptRun.exhaustionResult.priority >= exhaustionResult.priority)
    ) {
      exhaustionResult = attemptRun.exhaustionResult;
    }
    // Local coordination failures must not consume provider fallbacks (#83510).
    if (isNonProviderRuntimeCoordinationError(err) || isTranscriptNotContinuableError(err)) {
      throw err;
    }
    if (transientProbeProviderForAttempt) {
      const probeFailureReason = describeFailoverError(err).reason;
      if (!shouldPreserveTransientCooldownProbeSlot(probeFailureReason)) {
        cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
      }
    }
    // Compaction owns context overflow; provider request ceilings can use another quota.
    const errMessage = formatErrorMessage(err);
    if (isLikelyContextOverflowError(errMessage) && !hasProviderRequestSizeCeiling(err)) {
      throw err;
    }
    if (isMissingAgentHarnessError(err)) {
      throw err;
    }
    const normalized =
      coerceToFailoverError(err, {
        ...candidateRef,
        ...runAttribution,
      }) ?? err;

    // Jump to later live selections; stale targets remain classified failures.
    if (err instanceof LiveSessionModelSwitchError) {
      // The outer owner must apply runtime changes before selecting another model.
      if (
        hasDifferentLiveSessionRuntimeSelection({
          error: err,
          currentAgentHarnessRuntimeOverride: candidateHarnessAuth.agentHarnessRuntimeOverride,
        })
      ) {
        throw err;
      }
      const liveSwitchTargetIndex = resolveLiveSessionModelSwitchRedirectIndex({
        error: err,
        candidates,
        currentIndex: i,
      });
      if (liveSwitchTargetIndex !== null) {
        i = liveSwitchTargetIndex - 1;
        continue;
      }

      const switchMsg = err.message;
      const switchNormalized = new FailoverError(switchMsg, {
        reason: "unknown",
        ...candidateRef,
        ...runAttribution,
      });
      lastError = switchNormalized;
      await observeFailedCandidate({
        attempts,
        ...candObs,
        error: switchNormalized,
      });
      continue;
    }

    const isKnownFailover = isFailoverError(normalized);
    if (!isKnownFailover && !hasRemainingCandidate) {
      throw err;
    }

    // Cache non-primary auth failures for the next turn.
    if (
      isKnownFailover &&
      !isPrimary &&
      params.sessionId &&
      (normalized.reason === "auth" || normalized.reason === "auth_permanent")
    ) {
      markFallbackCandidateSkipped({
        sessionId: params.sessionId,
        ...candidateRef,
        // The inner runner records the profile that actually failed. Prefer
        // that fact because automatic routing can advance before the next turn.
        authScope: normalized.profileId?.trim() || candidateAuthScope,
        reason: normalized.reason,
      });
    }

    if (isKnownFailover && normalized.reason === "tls_certificate") {
      tlsFailedProviders.add(candidate.provider);
    }
    const failedNextCandidateIndex = resolveNextFallbackCandidateIndex({
      candidates,
      currentIndex: i,
      excludedProviders: tlsFailedProviders,
    });
    lastError = normalized;
    await recordFailure(normalized, candidates[failedNextCandidateIndex]);
    if (failedNextCandidateIndex > i + 1) {
      i = failedNextCandidateIndex - 1;
    }
  }

  if (exhaustionResult) {
    const selected =
      latestClassifiedResult && params.mergeExhaustedResult
        ? {
            ...latestClassifiedResult,
            result: params.mergeExhaustedResult({
              latestResult: latestClassifiedResult.result,
              preferredResult: exhaustionResult.result,
            }),
          }
        : exhaustionResult;
    return {
      outcome: "exhausted",
      result: selected.result,
      provider: selected.provider,
      model: selected.model,
      attempts,
    };
  }

  if (operatorAuthority?.modelPolicy && attempts.length === 0) {
    assertOperatorModelAllowed(operatorAuthority, undefined);
  }
  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
    soonestCooldownExpiry: resolveFallbackSoonestCooldownExpiry({
      authRuntime,
      userLockedAuthProfileId,
      agentDir: params.agentDir,
      cfg: params.cfg,
      profileIdsByCandidate,
    }),
    attribution: { sessionId: params.sessionId, lane: params.lane },
    cfg: params.cfg,
    agentId: params.agentId,
    agentDir: params.agentDir,
  });
}
