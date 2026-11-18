import {
  prepareCompactionEntries,
  type CompactionMessageProjection,
} from "../../../../packages/agent-core/src/harness/compaction/compaction-preparation.js";
import type {
  CompactionPreparation,
  CompactionResult,
} from "../../../../packages/agent-core/src/harness/compaction/compaction.js";
import { buildSessionContext } from "../../../../packages/agent-core/src/harness/session/session.js";
import type { AgentMessage } from "../../../../packages/agent-core/src/types.js";
import { SAFETY_MARGIN, estimateCompactionHistoryTokens } from "../context-token-pressure.js";
import { preflightManualSessionCompaction } from "../manual-compaction-preflight.js";
import type { SessionEntry } from "../session-manager-types.js";
import type {
  AgentCompactionPreparationOptions,
  CompactionRequestBudget,
} from "./preparation.types.js";
import {
  assertCompactionRequestCanFit,
  createStandaloneCompactionRequestBudget,
  estimateCompactedRequestTokens,
  resolveCompactionRetentionBudget,
} from "./request-budget.js";

type ProjectCompactionReplacement = (
  result: Pick<CompactionResult, "firstKeptEntryId" | "tokensBefore">,
  summary: string,
) => AgentMessage[];

export type AgentCompactionWorkPreparation =
  | { status: "skipped"; reason: string }
  | {
      status: "prepared";
      requestBudget: CompactionRequestBudget | undefined;
      pendingEntryIndex: number;
      pendingEntryId: string | undefined;
      requestTokenLimit: number | undefined;
      contextMessages: AgentMessage[];
      preparation: CompactionPreparation;
      projectReplacement: ProjectCompactionReplacement;
    };

/** Plans the SDK's current-array compaction without model, session, or write authority. */
export function prepareAgentCompactionWork(
  pathEntries: SessionEntry[],
  options: AgentCompactionPreparationOptions,
  onMessageProjection?: CompactionMessageProjection,
): AgentCompactionWorkPreparation {
  const isManual = options.mode === "manual";
  const requestBudget =
    options.requestBudget ??
    createStandaloneCompactionRequestBudget({
      maxSummaryChars: options.settings.maxSummaryChars,
      contextWindow: options.contextWindow ?? 0,
      reserveTokens: options.settings.reserveTokens,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    });
  const pendingUserIdempotencyKey = requestBudget?.pendingTokens
    ? requestBudget.pendingUserIdempotencyKey
    : undefined;
  const pendingEntryIndex =
    options.pendingUserEntryId || pendingUserIdempotencyKey
      ? pathEntries.findLastIndex(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "user" &&
            (options.pendingUserEntryId
              ? entry.id === options.pendingUserEntryId
              : "idempotencyKey" in entry.message &&
                entry.message.idempotencyKey === pendingUserIdempotencyKey),
        )
      : -1;
  if (options.pendingUserEntryId && pendingEntryIndex < 0) {
    throw new Error("Compaction cannot find the admitted pending user request.");
  }
  const contextMessages = requestBudget ? buildSessionContext(pathEntries).messages : [];
  assertCompactionRequestCanFit(contextMessages, requestBudget, true);
  const retention = requestBudget
    ? resolveCompactionRetentionBudget(
        requestBudget,
        contextMessages,
        options.settings.maxSummaryChars,
      )
    : undefined;
  const requestTokenLimit =
    requestBudget && retention
      ? requestBudget.fixedTokens + requestBudget.pendingTokens + retention.maxTokens
      : undefined;
  const requestBoundaryEntryId = options.requestFromEntryId ?? pathEntries[pendingEntryIndex]?.id;
  let preparation: CompactionPreparation | undefined;
  if (
    isManual &&
    !options.requestState &&
    pendingEntryIndex < 0 &&
    (!requestBudget || options.summaryOutputPolicy === "none")
  ) {
    const manualPreflight = preflightManualSessionCompaction(
      pathEntries,
      options.settings,
      onMessageProjection,
    );
    if (!manualPreflight.compactable) {
      throw new Error(manualPreflight.reason);
    }
    preparation = manualPreflight.preparation;
  } else {
    const result = prepareCompactionEntries(
      pathEntries,
      options.settings,
      // A queued input not in the transcript yet belongs to the prompt owner;
      // older history cannot stand in for that request.
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
            ...(requestBudget && retention
              ? {
                  budget: {
                    ...retention,
                    estimateTokens: (message: AgentMessage) =>
                      estimateCompactionHistoryTokens([message], requestBudget),
                  },
                }
              : {}),
          }
        : undefined,
      onMessageProjection,
    );
    if (!result.ok) {
      throw result.error;
    }
    preparation = result.value;
  }
  if (!preparation) {
    assertCompactionRequestCanFit(contextMessages, requestBudget, false);
    return { status: "skipped", reason: "Nothing to compact (session too small)" };
  }

  const projectReplacement = createCompactionReplacementProjector(pathEntries, options.itemId);
  if (requestBudget && requestTokenLimit !== undefined) {
    const remaining =
      requestTokenLimit -
      estimateCompactedRequestTokens(projectReplacement(preparation, ""), requestBudget);
    // Each producer fits its complete artifact before audit. Leave one token
    // for independent rounding of the summary and complete request estimates.
    preparation.summaryTokenBudget = Math.floor(remaining / SAFETY_MARGIN) - 1;
  }

  return {
    status: "prepared",
    requestBudget,
    pendingEntryIndex,
    pendingEntryId: pathEntries[pendingEntryIndex]?.id,
    requestTokenLimit,
    contextMessages,
    preparation,
    projectReplacement,
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
