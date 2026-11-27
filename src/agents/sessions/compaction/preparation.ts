import {
  prepareCompactionEntries,
  prepareCompactionEntryFacts,
  type CompactionFactPreparation,
  type CompactionMessageProjection,
  type PreparationConstraints,
} from "../../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionPreparation,
  CompactionResult,
  CompactionSettings,
} from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import {
  buildSessionContext,
  iterateSessionContextEntryFacts,
} from "../../../../packages/agent-core/src/harness/session/session.js";
import type { CompactionError, Result } from "../../../../packages/agent-core/src/harness/types.js";
import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import {
  SAFETY_MARGIN,
  estimateCompactionHistoryTokens,
  estimateCompactionHistoryTokensFromFacts,
  type MessageTokenPressureFact,
} from "../context-token-pressure.js";
import { preflightManualCompactionPreparation } from "../manual-compaction-preflight.js";
import type { SessionEntry } from "../session-manager-types.js";
import type {
  AgentCompactionFactPreparationOptions,
  AgentCompactionPreparationEntryFact,
  AgentCompactionPreparationOptions,
  CompactionRequestBudget,
} from "./preparation.types.js";
import {
  assertCompactionRequestCanFitFromTokens,
  createStandaloneCompactionRequestBudget,
  estimateCompactedRequestTokens,
  resolveCompactionRetentionBudgetFromTokens,
} from "./request-budget.js";

type ProjectCompactionReplacement = (
  result: Pick<CompactionResult, "firstKeptEntryId" | "tokensBefore">,
  summary: string,
) => AgentMessage[];

type PreparedWork<P> = {
  status: "prepared";
  requestBudget: CompactionRequestBudget | undefined;
  pendingEntryIndex: number;
  pendingEntryId: string | undefined;
  requestTokenLimit: number | undefined;
  preparation: P;
};
type SkippedWork = { status: "skipped"; reason: string };
export type AgentCompactionWorkPreparation =
  | SkippedWork
  | (PreparedWork<CompactionPreparation> & {
      contextMessages: AgentMessage[];
      projectReplacement: ProjectCompactionReplacement;
    });
export type AgentCompactionFactWorkPreparation =
  | SkippedWork
  | PreparedWork<CompactionFactPreparation>;

type WorkSource<E, P> = {
  isPendingUser: (entry: E, idempotencyKey: string | undefined) => boolean;
  historyEstimator: (budget: CompactionRequestBudget | undefined) => () => number;
  prepare: (
    settings: CompactionSettings,
    requestState?: "unresolved",
    constraints?: PreparationConstraints,
    budget?: CompactionRequestBudget,
  ) => Result<P | undefined, CompactionError>;
  emptyReplacementTokens: (preparation: P, budget: CompactionRequestBudget) => number;
};

/** Plans the SDK's current-array compaction without model, session, or write authority. */
export function prepareAgentCompactionWork(
  pathEntries: SessionEntry[],
  options: AgentCompactionPreparationOptions,
  onMessageProjection?: CompactionMessageProjection,
): AgentCompactionWorkPreparation {
  let contextMessages: AgentMessage[] = [];
  const projectReplacement = createCompactionReplacementProjector(pathEntries, options.itemId);
  const work = prepareAgentCompactionSource(pathEntries, options, {
    isPendingUser: (entry, key) =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      (options.pendingUserEntryId
        ? entry.id === options.pendingUserEntryId
        : "idempotencyKey" in entry.message && entry.message.idempotencyKey === key),
    historyEstimator: (budget) => {
      contextMessages = budget ? buildSessionContext(pathEntries).messages : [];
      return () => estimateCompactionHistoryTokens(contextMessages, budget);
    },
    prepare: (settings, state, constraints, budget) =>
      prepareCompactionEntries(
        pathEntries,
        settings,
        state,
        constraints
          ? {
              ...constraints,
              budget:
                constraints.budget && budget
                  ? {
                      ...constraints.budget,
                      estimateTokens: (message: AgentMessage) =>
                        estimateCompactionHistoryTokens([message], budget),
                    }
                  : undefined,
            }
          : undefined,
        onMessageProjection,
      ),
    emptyReplacementTokens: (preparation, budget) =>
      estimateCompactedRequestTokens(projectReplacement(preparation, ""), budget),
  });
  return work.status === "prepared" ? { ...work, contextMessages, projectReplacement } : work;
}

/** Fact-only planning; payload estimates are requested at the same lazy points as the array owner. */
export function prepareAgentCompactionWorkFromFacts(
  entries: readonly AgentCompactionPreparationEntryFact[],
  options: AgentCompactionFactPreparationOptions,
  estimateEmptyReplacementTokens: (
    preparation: CompactionFactPreparation,
    budget: CompactionRequestBudget,
  ) => number,
  readTokenPressure: (
    entry: AgentCompactionPreparationEntryFact,
    context: "message" | "current" | "retained" | "reset-retained",
  ) => MessageTokenPressureFact | undefined,
): AgentCompactionFactWorkPreparation {
  return prepareAgentCompactionSource(entries, options, {
    isPendingUser: (entry, key) =>
      entry.type === "message" &&
      entry.role === "user" &&
      (options.pendingUserEntryId
        ? entry.id === options.pendingUserEntryId
        : entry.idempotencyKey === key),
    historyEstimator: (budget) => () => {
      function* pressureFacts() {
        for (const { entry, context } of iterateSessionContextEntryFacts(entries)) {
          const fact = readTokenPressure(entry, context);
          if (fact) {
            yield fact;
          }
        }
      }
      return estimateCompactionHistoryTokensFromFacts(pressureFacts(), budget);
    },
    prepare: (settings, state, constraints, budget) =>
      prepareCompactionEntryFacts(
        entries,
        settings,
        state,
        constraints,
        constraints?.budget && budget
          ? (entry) => {
              const pressure = readTokenPressure(entry, "message");
              return estimateCompactionHistoryTokensFromFacts(pressure ? [pressure] : [], budget);
            }
          : undefined,
      ),
    emptyReplacementTokens: estimateEmptyReplacementTokens,
  });
}

function prepareAgentCompactionSource<
  E extends { id: string; type: string },
  P extends Pick<CompactionPreparation, "firstKeptEntryId" | "tokensBefore" | "summaryTokenBudget">,
>(
  pathEntries: readonly E[],
  options: AgentCompactionPreparationOptions &
    Pick<AgentCompactionFactPreparationOptions, "fixedTokenPressure">,
  source: WorkSource<E, P>,
): SkippedWork | PreparedWork<P> {
  const requestBudget =
    options.requestBudget ??
    createStandaloneCompactionRequestBudget({
      maxSummaryChars: options.settings.maxSummaryChars,
      contextWindow: options.contextWindow ?? 0,
      reserveTokens: options.settings.reserveTokens,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
      fixedTokenPressure: options.fixedTokenPressure,
    });
  const pendingUserIdempotencyKey = requestBudget?.pendingTokens
    ? requestBudget.pendingUserIdempotencyKey
    : undefined;
  const pendingEntryIndex =
    options.pendingUserEntryId || pendingUserIdempotencyKey
      ? pathEntries.findLastIndex((entry) => source.isPendingUser(entry, pendingUserIdempotencyKey))
      : -1;
  if (options.pendingUserEntryId && pendingEntryIndex < 0) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  const historyTokens = source.historyEstimator(requestBudget);
  assertCompactionRequestCanFitFromTokens(historyTokens, requestBudget, true);
  const retention = requestBudget
    ? resolveCompactionRetentionBudgetFromTokens(
        requestBudget,
        historyTokens,
        options.settings.maxSummaryChars,
      )
    : undefined;
  const requestTokenLimit =
    requestBudget && retention
      ? requestBudget.fixedTokens + requestBudget.pendingTokens + retention.maxTokens
      : undefined;
  const requestBoundaryEntryId = options.requestFromEntryId ?? pathEntries[pendingEntryIndex]?.id;
  let preparation: P | undefined;
  if (
    options.mode === "manual" &&
    !options.requestState &&
    pendingEntryIndex < 0 &&
    (!requestBudget || options.summaryOutputPolicy === "none")
  ) {
    const preflight = preflightManualCompactionPreparation(
      options.settings,
      pathEntries.at(-1)?.type,
      (settings) => source.prepare(settings),
    );
    if (!preflight.compactable) {
      throw new Error(preflight.reason);
    }
    preparation = preflight.preparation;
  } else {
    const result = source.prepare(
      options.settings,
      // Unrecorded queued input belongs to the prompt owner, not older history.
      pendingUserIdempotencyKey && pendingEntryIndex < 0 ? undefined : options.requestState,
      requestBudget || requestBoundaryEntryId
        ? {
            ...(requestBoundaryEntryId
              ? {
                  requestBoundary: {
                    entryId: requestBoundaryEntryId,
                    preserve: pathEntries[pendingEntryIndex]?.id === requestBoundaryEntryId,
                  },
                }
              : {}),
            ...(retention ? { budget: retention } : {}),
          }
        : undefined,
      requestBudget,
    );
    if (!result.ok) {
      throw result.error;
    }
    preparation = result.value;
  }
  if (!preparation) {
    assertCompactionRequestCanFitFromTokens(historyTokens, requestBudget, false);
    return { status: "skipped", reason: "Nothing to compact (session too small)" };
  }
  if (requestBudget && requestTokenLimit !== undefined) {
    const remaining = requestTokenLimit - source.emptyReplacementTokens(preparation, requestBudget);
    // Leave one token for independent summary and complete-request rounding.
    preparation.summaryTokenBudget = Math.floor(remaining / SAFETY_MARGIN) - 1;
  }
  return {
    status: "prepared",
    requestBudget,
    pendingEntryIndex,
    pendingEntryId: pathEntries[pendingEntryIndex]?.id,
    requestTokenLimit,
    preparation,
  };
}

/** One projection owner for full history and the private retained-only consumer. */
export function createCompactionReplacementProjector(
  pathEntries: SessionEntry[],
  itemId: string,
): ProjectCompactionReplacement {
  return (result: Pick<CompactionResult, "firstKeptEntryId" | "tokensBefore">, summary: string) =>
    buildSessionContext([
      ...pathEntries,
      {
        ...result,
        type: "compaction",
        id: itemId,
        parentId: pathEntries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(),
        summary,
      },
    ]).messages;
}
