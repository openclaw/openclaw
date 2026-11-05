import { formatErrorMessage } from "../infra/errors.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { FailoverError, coerceToFailoverError, isFailoverError } from "./failover-error.js";
import { isLikelyContextOverflowError } from "./failover/classify.js";
import type { ModelCandidate, ModelQuotaRecoveryPolicy } from "./model-fallback.types.js";

export function normalizeFallbackError(
  err: unknown,
  failoverContext: Parameters<typeof coerceToFailoverError>[1],
): unknown {
  return (
    coerceToFailoverError(err, failoverContext) ??
    (isLikelyContextOverflowError(formatErrorMessage(err))
      ? new FailoverError(formatErrorMessage(err), {
          reason: "context_overflow",
          ...failoverContext,
          cause: err,
        })
      : err)
  );
}

export function withQuotaRecovery(
  error: unknown,
  params: { modelQuotaRecoveryPolicy?: ModelQuotaRecoveryPolicy; abortSignal?: AbortSignal },
  attempt: {
    candidates: readonly ModelCandidate[];
    candidate: ModelCandidate;
    candidateAuthProfileIds?: readonly string[];
    authStore: AuthProfileStore | null;
    selectionChanged: boolean;
    operatorAuthority?: AdmittedRunOperatorAuthority;
  },
): unknown {
  const {
    candidates,
    candidate,
    candidateAuthProfileIds,
    authStore,
    selectionChanged,
    operatorAuthority,
  } = attempt;
  let normalized = error;
  const policy = params.modelQuotaRecoveryPolicy;
  if (
    isFailoverError(normalized) &&
    normalized.quotaScope === "daily-model" &&
    normalized.status === 429 &&
    normalized.code === "RESOURCE_EXHAUSTED" &&
    normalized.reason === "rate_limit" &&
    policy?.kind === "eligible" &&
    candidates.length === 1 &&
    candidateAuthProfileIds?.length === 1 &&
    authStore !== null &&
    listProfilesForProvider(authStore, candidate.provider).length === 1 &&
    candidate.provider === policy.target.provider &&
    candidate.model !== policy.target.model &&
    !selectionChanged &&
    operatorAuthority?.modelPolicy?.allows(policy.target) !== false &&
    !params.abortSignal?.aborted
  ) {
    // This fact never appends a candidate or replays input. The admission owner
    // must separately prove transcript continuation; availability remains live.
    normalized =
      coerceToFailoverError(normalized, {
        quotaRecovery: { ...policy.target, continuation: "unavailable" },
      }) ?? normalized;
  }
  return normalized;
}
