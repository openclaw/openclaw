import { formatErrorMessage } from "../../infra/errors.js";
import { recordModelFallbackStop } from "../failover-error.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import { selectAgentHarness } from "../harness/selection.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";
import type { ModelFallbackCandidate } from "../model-fallback.types.js";
import { isEmbeddedModelSelectionStrict } from "./embedded-cyber-failover.js";
import { readQuotaContinuation, type QuotaContinuation } from "./quota-continuation.js";
import type { RunEntryCandidate, EmbeddedAgentRunEntryParams } from "./run-entry.types.js";
import type { createQuotaContinuationBudget } from "./run/quota-continuation-budget.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type SearchResult<T extends EmbeddedAgentRunResult> = Awaited<
  ReturnType<typeof runWithModelFallback<RunEntryCandidate<T>>>
>;
export async function runQuotaContinuation<T extends EmbeddedAgentRunResult>(input: {
  params: EmbeddedAgentRunEntryParams<T>;
  originalFallbackResult: SearchResult<T>;
  continuationCandidates: readonly ModelFallbackCandidate[];
  consumedContinuationCandidates: ReadonlySet<string>;
  quotaBudget: ReturnType<typeof createQuotaContinuationBudget>;
  canFallback?: () => boolean;
  discardSourceAttempt: (facts: ContextEngineTurnAttemptFacts) => void;
  runFallbackSearch: (
    selection: EmbeddedAgentRunEntryParams<T>["selection"],
    options: { forceFallbackRetry: true; quotaContinuation: QuotaContinuation },
  ) => Promise<SearchResult<T>>;
}): Promise<{ fallbackResult: SearchResult<T>; quotaContinued: boolean }> {
  const {
    params,
    originalFallbackResult,
    continuationCandidates,
    consumedContinuationCandidates,
    quotaBudget,
    canFallback,
    discardSourceAttempt,
    runFallbackSearch,
  } = input;
  let fallbackResult = originalFallbackResult;
  let quotaContinued = false;
  const quotaContinuation = await readQuotaContinuation(
    originalFallbackResult.result.result,
    params.identity,
    () => !params.abortSignal?.aborted && canFallback?.() !== false,
  );
  if (
    quotaContinuation &&
    quotaBudget.remainingMs() > 0 &&
    (params.behavior.kind === "command-rpc" || params.behavior.kind === "channel-delivery") &&
    !params.abortSignal?.aborted &&
    canFallback?.() !== false &&
    !params.selection.userLockedAuthProfileId &&
    !isEmbeddedModelSelectionStrict(params.selection)
  ) {
    // Reuse the selection owner's configured chain, never an arbitrary recovery model.
    const sourceIndex = continuationCandidates.findIndex(
      (candidate) =>
        candidate.provider === originalFallbackResult.provider &&
        candidate.model === originalFallbackResult.model,
    );
    const candidates = (
      sourceIndex < 0 ? [] : continuationCandidates.slice(sourceIndex + 1)
    ).filter((candidate) => {
      if (
        candidate.routeOrigin !== "configured-fallback" ||
        consumedContinuationCandidates.has(JSON.stringify([candidate.provider, candidate.model])) ||
        candidate.provider === originalFallbackResult.provider
      ) {
        return false;
      }
      try {
        return (
          selectAgentHarness({
            config: params.selection.cfg,
            agentId: params.identity.agentId,
            sessionKey: params.harness.sessionKey,
            provider: candidate.provider,
            modelId: candidate.model,
            agentHarnessRuntimeOverride: params.harness.resolveRuntimeOverride(
              candidate.provider,
              candidate.model,
            ),
          }).id === "openclaw"
        );
      } catch {
        return false;
      }
    });
    const candidate = candidates[0];
    if (candidate) {
      const original = originalFallbackResult.result.result;
      if (originalFallbackResult.result.turnAttempt) {
        discardSourceAttempt(originalFallbackResult.result.turnAttempt);
      }
      try {
        const continued = await runFallbackSearch(
          {
            ...params.selection,
            provider: candidate.provider,
            model: candidate.model,
            requestedRouteResolution: candidate.routeResolution,
            fallbacksOverride: candidates
              .slice(1)
              .map((entry) => `${entry.provider}/${entry.model}`),
          },
          { forceFallbackRetry: true, quotaContinuation },
        );
        const result = continued.result.result;
        quotaContinued = true;
        fallbackResult = {
          ...continued,
          result: {
            ...continued.result,
            result: {
              ...result,
              meta: {
                ...result.meta,
                replayInvalid: true,
                ...(result.meta.error
                  ? {
                      error: {
                        ...result.meta.error,
                        message: `${original.meta.error?.message}\nContinuation failed: ${result.meta.error.message}`,
                        fallbackSafe: false,
                      },
                    }
                  : {}),
              },
            },
          },
          attempts: [
            ...originalFallbackResult.attempts,
            {
              provider: originalFallbackResult.provider,
              model: originalFallbackResult.model,
              error:
                original.meta.error?.message ??
                "Provider quota exhausted; whole-turn replay is unsafe.",
              reason: "rate_limit",
              status: 429,
              code: "settled_quota_continuation",
            },
            ...continued.attempts,
          ],
        };
      } catch (error) {
        if (params.abortSignal?.aborted) {
          throw error;
        }
        // A thrown successor may already own work or delivery. Do not swap it
        // for the old result or allow an outer owner to replay the original turn.
        const stopped = new Error(
          `${original.meta.error?.message ?? "Provider quota exhausted"}\n` +
            `Quota continuation failed: ${formatErrorMessage(error)}. ` +
            "Whole-turn replay remains blocked; do not repeat completed actions.",
          { cause: error },
        );
        recordModelFallbackStop(stopped);
        throw stopped;
      }
    }
  }
  return { fallbackResult, quotaContinued };
}
