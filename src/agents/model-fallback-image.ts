/** Runs image model candidates through the shared fallback attempt machinery. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  assertAdmittedRunOperatorAuthority,
  assertOperatorModelAllowed,
  type AdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import {
  type ModelFallbackErrorHandler,
  type ModelFallbackRunResult,
  runFallbackAttempt,
  throwFallbackFailureSummary,
} from "./model-fallback-attempt.js";
import { resolveImageFallbackCandidates } from "./model-fallback-candidates.js";
import type { FallbackAttempt } from "./model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";

type ImageFallbackSelectionParams = {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  manifestPlugins?: ModelManifestNormalizationContext["manifestPlugins"];
  operatorAuthority?: AdmittedRunOperatorAuthority;
};

/** Resolve one canonical candidate set for preparation and image/PDF execution. */
export function resolveAllowedImageFallbackCandidates(params: ImageFallbackSelectionParams) {
  const authority = params.operatorAuthority;
  if (authority) {
    assertAdmittedRunOperatorAuthority(authority);
    authority.assertCurrent();
  }
  const candidates = resolveImageFallbackCandidates(params);
  if (params.modelOverride?.trim()) {
    assertOperatorModelAllowed(
      authority,
      candidates.find((candidate) => candidate.routeOrigin === "requested"),
    );
  }
  const policy = authority?.modelPolicy;
  if (!policy) {
    return candidates;
  }
  const allowed = candidates.filter((candidate) => policy.allows(candidate));
  assertOperatorModelAllowed(authority, allowed[0]);
  return allowed;
}

export async function runWithImageModelFallback<T>(
  params: ImageFallbackSelectionParams & {
    run: (provider: string, model: string) => Promise<T>;
    onError?: ModelFallbackErrorHandler;
    abortSignal?: AbortSignal;
  },
): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveAllowedImageFallbackCandidates(params);
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const [i, candidate] of candidates.entries()) {
    assertOperatorModelAllowed(params.operatorAuthority, candidate);
    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      attempt: i + 1,
      total: candidates.length,
      abortSignal: params.abortSignal,
    }).catch((error: unknown) => {
      params.operatorAuthority?.assertCurrent();
      params.abortSignal?.throwIfAborted();
      throw error;
    });
    assertOperatorModelAllowed(params.operatorAuthority, candidate);
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    const err = attemptRun.error;
    lastError = err;
    attempts.push({
      provider: candidate.provider,
      model: candidate.model,
      error: formatErrorMessage(err),
    });
    await params.onError?.({
      provider: candidate.provider,
      model: candidate.model,
      error: err,
      attempt: i + 1,
      total: candidates.length,
    });
  }

  return throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
    cfg: params.cfg,
  });
}
