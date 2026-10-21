import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import { emitDiagnosticsTimelineEvent } from "../../../infra/diagnostics-timeline.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "../../auth-profiles.js";
import { revokeRuntimeAuthMaterializations } from "../../auth-profiles/runtime-materializations.js";
import {
  FailoverError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
} from "../../failover-error.js";
import { hasLongWindowRateLimitEvidence } from "../../failover/retry-evidence.js";
import type { FailoverReason } from "../../failover/signal.js";
import { renderRateLimitRetryExhaustion } from "../../failover/user-copy.js";
import { isConfigBackedInlineProviderApiKey } from "../../model-auth.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { prepareEmbeddedRunRuntime } from "./runtime.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_TRANSIENT_RETRIES = 8;
const MAX_OUTPUT_LIMIT_RETRIES = 1;
const MAX_TRANSIENT_RETRY_TIME_MS = 90_000;
const TRANSIENT_RETRY_BASE_DELAY_MS = 1_000;
const TRANSIENT_RETRY_MAX_DELAY_MS = 30_000;

function resolveTransientRetryDelayMs(params: {
  retryNumber: number;
  retryAfterMs?: number;
  elapsedMs?: number;
}): number | undefined {
  const remainingMs =
    params.elapsedMs === undefined
      ? Infinity
      : MAX_TRANSIENT_RETRY_TIME_MS - Math.max(0, params.elapsedMs);
  // The header parser uses Infinity for a floor too large to represent safely.
  if (remainingMs <= 0 || params.retryAfterMs === Infinity) {
    return undefined;
  }
  const exponentialMs = Math.min(
    TRANSIENT_RETRY_MAX_DELAY_MS,
    TRANSIENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, params.retryNumber - 1),
  );
  const jitteredMs = Math.min(
    TRANSIENT_RETRY_MAX_DELAY_MS,
    Math.round(exponentialMs * (0.5 + Math.random())),
  );
  const retryAfterMs = Number.isFinite(params.retryAfterMs)
    ? Math.max(0, Math.ceil(params.retryAfterMs ?? 0))
    : 0;
  const delayMs = Math.max(jitteredMs, retryAfterMs);
  return delayMs <= remainingMs ? delayMs : undefined;
}

const MAX_RATE_LIMIT_ATTEMPTS = 10;
const MAX_OVERLOAD_PROFILE_ROTATIONS = 1;
const MAX_RATE_LIMIT_PROFILE_ROTATIONS = 1;
const RETRY_SLEEP_CHUNK_MS = 24 * 60 * 60 * 1000;

type PreparedRuntime = Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
export type EmbeddedRunFailoverRetryController = ReturnType<
  typeof createEmbeddedRunFailoverRetryController
>;
type AuthRetryTrace = TraceAttempt & { reason: FailoverReason };
type TransientRetryReason = FailoverReason | "output_limit";

type RateLimitAuthProfileContext = {
  failoverProvider: string;
  failoverModel: string;
  logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
};

export function createEmbeddedRunFailoverRetryController(input: {
  runInput: Pick<
    PreparedEmbeddedRunInput,
    "runParams" | "globalLane" | "agentDir" | "fallbackConfigured"
  >;
  preparedRuntime: Pick<
    PreparedRuntime,
    "provider" | "modelId" | "profileFailureStore" | "getApiKeyInfo" | "advanceAttemptAuthProfile"
  > & {
    snapshot: () => {
      lastProfileId?: string;
      pluginHarnessOwnsTransport: boolean;
      agentHarness: { id: string };
      transportConfig?: PreparedEmbeddedRunInput["runParams"]["config"];
    };
  };
  getSessionId: () => string;
}) {
  const { runInput, preparedRuntime } = input;
  const { runParams: params, globalLane, agentDir, fallbackConfigured } = runInput;
  const { provider, modelId } = preparedRuntime;
  const advanceAttemptAuthProfile = preparedRuntime.advanceAttemptAuthProfile;
  let rateLimitProfileRotations = 0;
  let transientRetryCount = 0;
  let outputLimitRetryCount = 0;
  let rateLimitSeen = false;
  let transientRetryBudget: number | undefined;
  let rateLimitRetriesExhausted: number | undefined;
  // Consecutive outages count failed-request time as well as backoff. A completed
  // successful model response ends the outage and replenishes its retry budget.
  let transientRetryWindowStartMs: number | null = null;

  const resolveProfileFailureReason = (
    failoverReason: FailoverReason | null,
    opts?: { providerStarted?: boolean; transientRateLimit?: boolean },
  ) =>
    resolveAuthProfileFailureReason({
      failoverReason,
      providerStarted: opts?.providerStarted,
      transientRateLimit: opts?.transientRateLimit,
      policy: params.authProfileFailurePolicy,
    });

  const maybeMarkAuthProfileFailure = async (failure: {
    profileId?: string;
    reason?: AuthProfileFailureReason | null;
    modelId?: string;
    retryAfterMs?: number;
  }) => {
    const { profileId, reason } = failure;
    if (
      preparedRuntime.snapshot().pluginHarnessOwnsTransport &&
      (reason === "auth" || reason === "auth_permanent")
    ) {
      revokeRuntimeAuthMaterializations({
        agentDir,
        provider,
        runtimeOwnerId: preparedRuntime.snapshot().agentHarness.id,
      });
    }
    if (params.authProfileStateMode === "read-only" || !reason) {
      return;
    }
    if (preparedRuntime.snapshot().pluginHarnessOwnsTransport && reason === "timeout") {
      return;
    }
    const failureParams = {
      store: preparedRuntime.profileFailureStore,
      reason,
      cfg: preparedRuntime.snapshot().transportConfig ?? params.config,
      agentDir,
      runId: params.runId,
      modelId: failure.modelId,
      retryAfterMs: failure.retryAfterMs,
    };
    if (profileId) {
      await markAuthProfileFailure({
        ...failureParams,
        profileId,
      });
      return;
    }
    const apiKeyInfo = preparedRuntime.getApiKeyInfo();
    if (
      apiKeyInfo?.mode !== "api-key" ||
      !isConfigBackedInlineProviderApiKey({
        cfg: preparedRuntime.snapshot().transportConfig ?? params.config,
        provider,
        source: apiKeyInfo.source,
        store: preparedRuntime.profileFailureStore,
      })
    ) {
      return;
    }
    await markInlineProviderApiKeyFailure({
      ...failureParams,
      provider,
    });
  };

  const advanceRateLimitAuthProfile = async (context: RateLimitAuthProfileContext) => {
    if (rateLimitProfileRotations >= MAX_RATE_LIMIT_PROFILE_ROTATIONS && fallbackConfigured) {
      const status = resolveFailoverStatus("rate_limit");
      log.warn(
        `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
      );
      context.logFallbackDecision("fallback_model", { status });
      throw new FailoverError(
        renderRateLimitRetryExhaustion(rateLimitRetriesExhausted) ??
          "The AI service is temporarily rate-limited. Please try again in a moment.",
        {
          reason: "rate_limit",
          rateLimitRetriesExhausted,
          provider: context.failoverProvider,
          model: context.failoverModel,
          profileId: preparedRuntime.snapshot().lastProfileId,
          sessionId: input.getSessionId(),
          lane: globalLane,
          status,
        },
      );
    }
    const rotated = await preparedRuntime.advanceAttemptAuthProfile();
    if (rotated) {
      rateLimitProfileRotations += 1;
    }
    return rotated;
  };

  return {
    overloadProfileRotationLimit: MAX_OVERLOAD_PROFILE_ROTATIONS,
    get transientRetryCount() {
      return transientRetryCount;
    },
    get rateLimitRetriesExhausted() {
      return rateLimitRetriesExhausted;
    },
    observeAttempt: (
      attempt: Pick<
        EmbeddedRunAttemptResult,
        "providerRetryMaxRetries" | "hasSuccessfulModelResponse"
      >,
    ) => {
      transientRetryBudget = attempt.providerRetryMaxRetries;
      rateLimitRetriesExhausted = undefined;
      if (attempt.hasSuccessfulModelResponse) {
        transientRetryCount = 0;
        rateLimitSeen = false;
        transientRetryWindowStartMs = null;
      }
    },
    advanceAuthProfile: (reason: FailoverReason | null, context: RateLimitAuthProfileContext) => {
      if (
        params.retryTransientErrors === false &&
        (reason === "rate_limit" ||
          reason === "overloaded" ||
          reason === "server_error" ||
          reason === "timeout")
      ) {
        return Promise.resolve(false);
      }
      return reason === "rate_limit"
        ? advanceRateLimitAuthProfile(context)
        : advanceAttemptAuthProfile();
    },
    maybeMarkAuthProfileFailure,
    resolveAuthProfileFailureReason: resolveProfileFailureReason,
    recoverThrownHarnessAuthFailure: async (error: unknown): Promise<AuthRetryTrace | null> => {
      // Native harnesses can throw before returning a terminal result. Recover only
      // provider-auth failures here; local harness faults must keep propagating.
      if (!preparedRuntime.snapshot().pluginHarnessOwnsTransport) {
        return null;
      }
      const failoverReason = resolveFailoverReasonFromError(error, provider);
      if (failoverReason !== "auth" && failoverReason !== "auth_permanent") {
        return null;
      }
      const failedProfileId = preparedRuntime.snapshot().lastProfileId;
      const profileFailureReason = resolveProfileFailureReason(failoverReason);
      const userPinnedProfile =
        params.authProfileIdSource === "user" && failedProfileId === params.authProfileId;
      const rotated = userPinnedProfile ? false : await preparedRuntime.advanceAttemptAuthProfile();
      try {
        await maybeMarkAuthProfileFailure({
          profileId: failedProfileId,
          reason: profileFailureReason,
          modelId,
        });
      } catch (markError) {
        log.warn(`profile failure mark failed: ${String(markError)}`);
      }
      return rotated
        ? {
            provider,
            model: modelId,
            result: "rotate_profile",
            reason: failoverReason,
            stage: "prompt",
          }
        : null;
    },
    maybeRetryTransient: async (retry: {
      reason: TransientRetryReason;
      sameModelRetry?: boolean;
      message?: string;
      code?: string;
      retryAfterMs?: number;
      /** Saved retry.provider.maxRetryDelayMs; undefined or 0 disables the cap. */
      maxRetryDelayMs?: number;
      /** False when the attempt cannot fail over (replay-unsafe tool activity). */
      failoverEligible?: boolean;
      onRetry?: (status: {
        attempt: number;
        maxRetries: number;
        delayMs: number;
        reason: TransientRetryReason;
      }) => void | Promise<void>;
    }): Promise<boolean> => {
      rateLimitRetriesExhausted = undefined;
      const recordDecision = (
        decision: "accepted" | "rejected",
        reason:
          | "non_transient"
          | "connection_retry_disabled"
          | "transient_retry_disabled"
          | "long_window_rate_limit"
          | "retry_budget_exhausted"
          | "retry_delay_unavailable"
          | "retry_delay_exceeds_cap"
          | "wait_interrupted"
          | "backoff_completed",
      ) =>
        emitDiagnosticsTimelineEvent(
          {
            type: "mark",
            name: "model.retry.decision",
            runId: params.runId,
            attributes: { decision, reason, retryCount: transientRetryCount },
          },
          { config: params.config },
        );
      if (params.retryTransientErrors === false && retry.reason !== "output_limit") {
        recordDecision("rejected", "transient_retry_disabled");
        return false;
      }
      if (
        params.retryConnectionErrors === false &&
        retry.code !== undefined &&
        ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"].includes(retry.code)
      ) {
        recordDecision("rejected", "connection_retry_disabled");
        return false;
      }
      if (
        retry.reason !== "rate_limit" &&
        retry.reason !== "overloaded" &&
        retry.reason !== "server_error" &&
        retry.reason !== "timeout" &&
        retry.reason !== "output_limit"
      ) {
        recordDecision("rejected", "non_transient");
        return false;
      }
      const rateLimit = retry.reason === "rate_limit";
      if (rateLimit && hasLongWindowRateLimitEvidence(retry.message)) {
        recordDecision("rejected", "long_window_rate_limit");
        return false;
      }
      if (retry.sameModelRetry === false) {
        recordDecision("rejected", "non_transient");
        return false;
      }
      // Bound replay-safe waits; the failover owner rotates credentials, tries
      // configured models, or surfaces the existing error after exhaustion.
      const retryDelayCapMs =
        retry.maxRetryDelayMs !== undefined &&
        Number.isFinite(retry.maxRetryDelayMs) &&
        retry.maxRetryDelayMs > 0
          ? retry.maxRetryDelayMs
          : undefined;
      if (
        rateLimit &&
        retry.failoverEligible !== false &&
        retryDelayCapMs !== undefined &&
        retry.retryAfterMs !== undefined &&
        retry.retryAfterMs > retryDelayCapMs
      ) {
        recordDecision("rejected", "retry_delay_exceeds_cap");
        log.warn(
          `rate-limit retry floor ${retry.retryAfterMs === Infinity ? "exceeds representable time" : `${retry.retryAfterMs}ms`} exceeds retry.provider.maxRetryDelayMs=${retryDelayCapMs} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)}; failing over`,
        );
        return false;
      }
      rateLimitSeen ||= rateLimit;
      const retryCount = transientRetryCount;
      const retryBudget = Math.min(
        transientRetryBudget ?? (rateLimit ? MAX_RATE_LIMIT_ATTEMPTS - 1 : MAX_TRANSIENT_RETRIES),
        rateLimitSeen ? MAX_RATE_LIMIT_ATTEMPTS - 1 : Infinity,
      );
      if (
        retryCount >= retryBudget ||
        (retry.reason === "output_limit" && outputLimitRetryCount >= MAX_OUTPUT_LIMIT_RETRIES)
      ) {
        if (rateLimit) {
          rateLimitRetriesExhausted = retryBudget === 0 ? 0 : retryCount;
        }
        recordDecision("rejected", "retry_budget_exhausted");
        return false;
      }
      const nowMs = Date.now();
      const retryWindowStartMs = transientRetryWindowStartMs ?? nowMs;
      if (retry.reason !== "output_limit") {
        transientRetryWindowStartMs = retryWindowStartMs;
      }
      const delayMs = resolveTransientRetryDelayMs({
        retryNumber: retryCount + 1,
        retryAfterMs: retry.retryAfterMs,
        // Reaching an output ceiling can take minutes of useful generation.
        // Keep its count budget and timeout controls without the outage time window.
        elapsedMs:
          rateLimit || retry.reason === "output_limit" ? undefined : nowMs - retryWindowStartMs,
      });
      if (delayMs === undefined) {
        recordDecision("rejected", "retry_delay_unavailable");
        // Explain why recovery stopped before the count limit; replay safety still gates fallback.
        log.warn(
          `transient retry ${retry.retryAfterMs === Infinity ? "floor exceeds representable time" : "window elapsed"} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${transientRetryCount}/${retryBudget} retries; stopping same-model retries`,
        );
        return false;
      }
      if (rateLimit) {
        try {
          await maybeMarkAuthProfileFailure({
            profileId: preparedRuntime.snapshot().lastProfileId,
            reason: resolveProfileFailureReason("rate_limit", { transientRateLimit: true }),
            modelId,
            retryAfterMs: retry.retryAfterMs,
          });
        } catch (error) {
          log.warn(`profile failure mark failed: ${String(error)}`);
        }
      }
      const outputLimit = retry.reason === "output_limit";
      const attempt = (outputLimit ? outputLimitRetryCount : retryCount) + 1;
      const maxRetries = outputLimit
        ? Math.min(retryBudget, MAX_OUTPUT_LIMIT_RETRIES)
        : retryBudget;
      log.warn(
        `${outputLimit ? "output-limit continuation" : "transient same-model retry"} ${attempt}/${maxRetries} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} reason=${retry.reason}: delayMs=${delayMs} runId=${JSON.stringify(params.runId)} sessionId=${JSON.stringify(input.getSessionId())}`,
      );
      try {
        await retry.onRetry?.({
          attempt,
          maxRetries,
          delayMs,
          reason: retry.reason,
        });
      } catch {
        log.warn("transient retry status callback failed; continuing retry");
      }
      const closeRetryWait = params.onRetryWait?.(Date.now() + delayMs, params.abortSignal);
      let completed = false;
      try {
        // Provider floors can exceed one native timer; protect the whole wait.
        let remainingMs = delayMs;
        while (remainingMs > 0) {
          const chunkMs = Math.min(remainingMs, RETRY_SLEEP_CHUNK_MS);
          try {
            await sleepWithAbort(chunkMs, params.abortSignal);
          } catch (error) {
            params.abortSignal?.throwIfAborted();
            throw error;
          }
          remainingMs -= chunkMs;
        }
        completed = true;
      } finally {
        if (!completed) {
          recordDecision("rejected", "wait_interrupted");
        }
        closeRetryWait?.(completed);
      }
      recordDecision("accepted", "backoff_completed");
      transientRetryCount += 1;
      if (retry.reason === "output_limit") {
        outputLimitRetryCount += 1;
      }
      return true;
    },
  };
}
