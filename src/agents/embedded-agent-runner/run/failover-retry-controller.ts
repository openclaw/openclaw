import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { sleepWithAbort } from "../../../infra/backoff.js";
import {
  type AuthProfileFailureReason,
  markAuthProfileFailure,
  markInlineProviderApiKeyFailure,
} from "../../auth-profiles.js";
import { revokeRuntimeAuthMaterializations } from "../../auth-profiles/runtime-materializations.js";
import type { FailoverReason } from "../../embedded-agent-helpers.js";
import {
  FailoverError,
  resolveFailoverReasonFromError,
  resolveFailoverStatus,
} from "../../failover-error.js";
import { hasLongWindowRateLimitEvidence } from "../../failover/retry-evidence.js";
import { isConfigBackedInlineProviderApiKey, type ResolvedProviderAuth } from "../../model-auth.js";
import { log } from "../logger.js";
import type { TraceAttempt } from "../types.js";
import { resolveAuthProfileFailureReason } from "./auth-profile-failure-policy.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

const MAX_TRANSIENT_RETRIES = 8;
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
  runParams: PreparedEmbeddedRunInput["runParams"];
  provider: string;
  modelId: string;
  globalLane: string;
  agentDir: string;
  fallbackConfigured: boolean;
  profileFailureStore: PreparedRuntime["profileFailureStore"];
  getLastProfileId: () => string | undefined;
  getSessionId: () => string;
  harnessOwnsTransport: () => boolean;
  getRuntimeAuthOwnerId: () => string;
  getApiKeyInfo: () => ResolvedProviderAuth | null;
  advanceAuthProfile: PreparedRuntime["advanceAttemptAuthProfile"];
}) {
  const {
    runParams: params,
    provider,
    modelId,
    globalLane,
    agentDir,
    fallbackConfigured,
    profileFailureStore,
  } = input;
  let rateLimitProfileRotations = 0;
  let transientRetryCount = 0;
  let rateLimitSeen = false;
  let transientRetryBudget: number | undefined;
  // Consecutive outages count failed-request time as well as backoff. A completed
  // successful model response ends the outage, but never refunds retry attempts.
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
  }) => {
    const { profileId, reason } = failure;
    if (input.harnessOwnsTransport() && (reason === "auth" || reason === "auth_permanent")) {
      revokeRuntimeAuthMaterializations({
        agentDir,
        provider,
        runtimeOwnerId: input.getRuntimeAuthOwnerId(),
      });
    }
    if (params.authProfileStateMode === "read-only" || !reason) {
      return;
    }
    if (input.harnessOwnsTransport() && reason === "timeout") {
      return;
    }
    if (profileId) {
      await markAuthProfileFailure({
        store: profileFailureStore,
        profileId,
        reason,
        cfg: params.config,
        agentDir,
        runId: params.runId,
        modelId: failure.modelId,
      });
      return;
    }
    const apiKeyInfo = input.getApiKeyInfo();
    if (
      apiKeyInfo?.mode !== "api-key" ||
      !isConfigBackedInlineProviderApiKey({
        cfg: params.config,
        provider,
        source: apiKeyInfo.source,
        store: profileFailureStore,
      })
    ) {
      return;
    }
    await markInlineProviderApiKeyFailure({
      store: profileFailureStore,
      provider,
      reason,
      cfg: params.config,
      agentDir,
      runId: params.runId,
      modelId: failure.modelId,
    });
  };

  return {
    overloadProfileRotationLimit: MAX_OVERLOAD_PROFILE_ROTATIONS,
    get transientRetryCount() {
      return transientRetryCount;
    },
    observeAttempt: (
      attempt: Pick<
        EmbeddedRunAttemptResult,
        "providerRetryMaxRetries" | "hasSuccessfulModelResponse"
      >,
    ) => {
      transientRetryBudget = attempt.providerRetryMaxRetries;
      if (attempt.hasSuccessfulModelResponse) {
        transientRetryWindowStartMs = null;
      }
    },
    advanceAuthProfile: input.advanceAuthProfile,
    advanceRateLimitAuthProfile: async (context: RateLimitAuthProfileContext): Promise<boolean> => {
      if (rateLimitProfileRotations >= MAX_RATE_LIMIT_PROFILE_ROTATIONS && fallbackConfigured) {
        const status = resolveFailoverStatus("rate_limit");
        log.warn(
          `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
        context.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            reason: "rate_limit",
            provider: context.failoverProvider,
            model: context.failoverModel,
            profileId: input.getLastProfileId(),
            sessionId: input.getSessionId(),
            lane: globalLane,
            status,
          },
        );
      }
      const rotated = await input.advanceAuthProfile();
      if (rotated) {
        rateLimitProfileRotations += 1;
      }
      return rotated;
    },
    maybeMarkAuthProfileFailure,
    resolveAuthProfileFailureReason: resolveProfileFailureReason,
    recoverThrownHarnessAuthFailure: async (error: unknown): Promise<AuthRetryTrace | null> => {
      // Native harnesses can throw before returning a terminal result. Recover only
      // provider-auth failures here; local harness faults must keep propagating.
      if (!input.harnessOwnsTransport()) {
        return null;
      }
      const failoverReason = resolveFailoverReasonFromError(error, provider);
      if (failoverReason !== "auth" && failoverReason !== "auth_permanent") {
        return null;
      }
      const failedProfileId = input.getLastProfileId();
      const profileFailureReason = resolveProfileFailureReason(failoverReason);
      const userPinnedProfile =
        params.authProfileIdSource === "user" && failedProfileId === params.authProfileId;
      const rotated = userPinnedProfile ? false : await input.advanceAuthProfile();
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
      message?: string;
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
      if (
        retry.reason !== "rate_limit" &&
        retry.reason !== "overloaded" &&
        retry.reason !== "server_error" &&
        retry.reason !== "timeout" &&
        retry.reason !== "output_limit"
      ) {
        return false;
      }
      const rateLimit = retry.reason === "rate_limit";
      if (rateLimit && hasLongWindowRateLimitEvidence(retry.message)) {
        return false;
      }
      // A 429 floor past the operator's maxRetryDelayMs is a usage window in
      // everything but wording: Anthropic's session-window exhaustion answers
      // with "try again later" and a Retry-After of hours, which matches no
      // keyword pattern. The SDK already refused to wait that long under the
      // same setting; sleeping it here instead holds the turn open until the
      // run's own timeout kills it. With a fallback configured and an attempt
      // that can still fail over, decline the wait now. Without either there is
      // nothing to do but wait, so the floor is honored: after a replay-unsafe
      // tool action neither profile rotation nor model fallback runs, so
      // declining here would end the turn instead of continuing it.
      const retryDelayCapMs =
        retry.maxRetryDelayMs !== undefined &&
        Number.isFinite(retry.maxRetryDelayMs) &&
        retry.maxRetryDelayMs > 0
          ? retry.maxRetryDelayMs
          : undefined;
      if (
        rateLimit &&
        fallbackConfigured &&
        retry.failoverEligible !== false &&
        retryDelayCapMs !== undefined &&
        retry.retryAfterMs !== undefined &&
        retry.retryAfterMs > retryDelayCapMs
      ) {
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
      if (retryCount >= retryBudget) {
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
        // Keep its count budget and run deadline without the outage time window.
        elapsedMs:
          rateLimit || retry.reason === "output_limit" ? undefined : nowMs - retryWindowStartMs,
      });
      if (delayMs === undefined) {
        // Explain why recovery stopped before the count limit; replay safety still gates fallback.
        log.warn(
          `transient retry ${retry.retryAfterMs === Infinity ? "floor exceeds representable time" : "window elapsed"} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${transientRetryCount}/${retryBudget} retries; stopping same-model retries`,
        );
        return false;
      }
      log.warn(
        `transient same-model retry ${retryCount + 1}/${retryBudget} for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} reason=${retry.reason}: delayMs=${delayMs}`,
      );
      await retry.onRetry?.({
        attempt: retryCount + 1,
        maxRetries: retryBudget,
        delayMs,
        reason: retry.reason,
      });
      const closeRetryWait = params.onRetryWait?.(Date.now() + delayMs, params.abortSignal);
      let completed = false;
      try {
        // Provider floors can exceed one native timer; protect the whole wait.
        let remainingMs = delayMs;
        while (remainingMs > 0) {
          const chunkMs = Math.min(remainingMs, RETRY_SLEEP_CHUNK_MS);
          await sleepWithAbort(chunkMs, params.abortSignal);
          remainingMs -= chunkMs;
        }
        completed = true;
      } finally {
        closeRetryWait?.(completed);
      }
      transientRetryCount += 1;
      return true;
    },
  };
}
