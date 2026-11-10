import {
  capCompactionSummary,
  fitCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
/** Extension that safeguards compaction with structured summaries and quality repair. */
import {
  clearCompactionPendingAskSection,
  computeFileLists,
  formatFileOperations,
} from "../../../packages/agent-core/src/harness/compaction/utils.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  getCompactionProvider,
  type CompactionProvider,
} from "../../plugins/compaction-provider.js";
import { recoverCompactionSafeguardFailure } from "../compaction-summary-refusal.js";
import { summarizeCompactionHistory } from "../compaction.js";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "../copilot-dynamic-headers.js";
import {
  buildSessionContext as buildCoreSessionContext,
  type AgentMessage,
  type SessionTreeEntry as CoreSessionTreeEntry,
} from "../runtime/index.js";
import type { SessionModelUsageSink } from "../sessions/compaction/runtime.js";
import type { ExtensionAPI, ExtensionContext } from "../sessions/index.js";
import { getPreparedCompaction } from "../sessions/prepared-compaction.js";
import type { ContextSection } from "../sessions/prepared-compaction.types.js";
import { recordSessionModelUsage } from "../sessions/session-model-usage.js";
import { resolveCompactionInstructions } from "./compaction-instructions.js";
import {
  budgetCompactionSummary,
  CONTEXT_TRUNCATED_MARKER,
  type CompactionSuffix,
  type SummaryQualityRetention,
} from "./compaction-safeguard-budget.js";
import {
  appendSummarySection,
  auditSummaryQuality,
  buildCompactionStructureInstructions,
  buildStructuredFallbackSummary,
  extractOpaqueIdentifiers,
  nestRequiredSummaryHeadings,
  resolveSummaryReserveTokens,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardCancellation,
} from "./compaction-safeguard-runtime.js";
import {
  arraySafeguardSource,
  materializeSafeguardSource,
  prepareCompactionSafeguardSource,
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildSplitTurnContextSection,
} from "./compaction-safeguard-source.js";
import { readWorkspaceContextForSummary } from "./compaction-workspace-context.js";

const log = createSubsystemLogger("compaction-safeguard");

const missedModelWarningSessions = new WeakSet<object>();
const SPLIT_TURN_SECTION_HEADING = "**Turn Context (split turn):**";
// Split-turn context supplements the generated summary and must not claim its
// guaranteed half of the final artifact before common finalization runs.
const MAX_SPLIT_TURN_CONTEXT_CHARS = Math.floor(MAX_COMPACTION_SUMMARY_CHARS / 2);
const DEFAULT_RECENT_TURNS_PRESERVE = 3;
const DEFAULT_QUALITY_GUARD_MAX_RETRIES = 1;
const MAX_RECENT_TURNS_PRESERVE = 12;
const MAX_QUALITY_GUARD_MAX_RETRIES = 3;
const compactionSafeguardDeps = {
  summarizeCompactionHistory,
};
type CompactionLoss =
  | "summary-tail"
  | "suffix-head"
  | "split-turn-head"
  | "split-turn-tail"
  | "preserved-turn-head"
  | "identifier-retention"
  | "quality-retention";

function nestMarkdownHeadings(text: string): string {
  return text.replace(/^##(?=[ \t]+\S)/gmu, "###");
}

function normalizeLegacySplitTurnSummary(summary: string | undefined): string | undefined {
  const splitTurnStart = summary?.indexOf(SPLIT_TURN_SECTION_HEADING) ?? -1;
  if (!summary || splitTurnStart < 0) {
    return summary;
  }
  const splitTurnContentStart = splitTurnStart + SPLIT_TURN_SECTION_HEADING.length;
  // Shipped safeguard summaries nested a second complete summary after this owned boundary.
  // Demote its headings only in the next model input; the persisted old boundary stays untouched.
  return `${summary.slice(0, splitTurnContentStart)}${nestRequiredSummaryHeadings(summary.slice(splitTurnContentStart))}`;
}

/**
 * The boundary-scoped range a preparation was meant to cover: everything the
 * current context holds before its kept tail, minus the prior summary message
 * (that is re-distilled separately). Bounded by construction — it can never
 * reach behind the last reset/compaction boundary.
 */
function collectPreparationRangeMessages(
  sessionManager: ExtensionContext["sessionManager"],
  firstKeptEntryId: string,
): AgentMessage[] {
  const entries = readSessionBranch(sessionManager);
  const firstKeptIndex = entries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (firstKeptIndex < 0) {
    return [];
  }
  // Keep replay boundaries even when their retained entries precede the physical marker.
  // The core projector, not the preparation cut, owns which older entries remain visible.
  return projectBranchEntries(
    entries.filter(
      (entry, index) =>
        index < firstKeptIndex || entry.type === "compaction" || entry.type === "reset",
    ),
  ).filter((message) => message.role !== "compactionSummary");
}

function readSessionBranch(
  sessionManager: ExtensionContext["sessionManager"],
): CoreSessionTreeEntry[] {
  return sessionManager.getBranch() as CoreSessionTreeEntry[];
}

function projectBranchEntries(entries: CoreSessionTreeEntry[]): AgentMessage[] {
  return buildCoreSessionContext(entries).messages as AgentMessage[];
}

async function resolveModelAuth(
  ctx: ExtensionContext,
  model: NonNullable<ExtensionContext["model"]>,
): Promise<
  { ok: true; apiKey?: string; headers?: typeof model.headers } | { ok: false; reason: string }
> {
  let requestAuth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>>;
  try {
    requestAuth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  } catch (err) {
    const error = formatErrorMessage(err);
    log.warn(
      `Compaction safeguard: request credentials unavailable; cancelling compaction. ${error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${error}`,
    };
  }
  if (!requestAuth.ok) {
    log.warn(
      `Compaction safeguard: request credential resolution failed for ${model.provider}/${model.id}: ${requestAuth.error}`,
    );
    return {
      ok: false,
      reason: `Compaction safeguard could not resolve request credentials for ${model.provider}/${model.id}: ${requestAuth.error}`,
    };
  }
  // `ok: true` is the registry's authoritative success signal; it already returns
  // `ok: false` when auth cannot resolve. Do not re-derive failure from absent
  // key/headers. SDK-managed modes (aws-sdk, oauth) sign the request later and
  // legitimately carry neither, so gating on them wedges compaction forever.
  return { ok: true, apiKey: requestAuth.apiKey, headers: requestAuth.headers };
}

function buildCompactionSummaryHeaders(params: {
  model: NonNullable<ExtensionContext["model"]>;
  messages: AgentMessage[];
  headers?: NonNullable<ExtensionContext["model"]>["headers"];
}): typeof params.headers {
  if (params.model.provider !== "github-copilot") {
    return params.headers;
  }
  const messages = params.messages as unknown as Parameters<
    typeof buildCopilotDynamicHeaders
  >[0]["messages"];
  return {
    ...buildCopilotDynamicHeaders({
      messages,
      hasImages: hasCopilotVisionInput(messages),
    }),
    ...params.headers,
  };
}

function clampNonNegativeInt(value: number | undefined, fallback: number, max: number): number {
  return Math.min(max, Math.max(0, Math.floor(value ?? fallback)));
}

function resolveRecentTurnsPreserve(value: number | undefined): number {
  return clampNonNegativeInt(value, DEFAULT_RECENT_TURNS_PRESERVE, MAX_RECENT_TURNS_PRESERVE);
}

function resolveQualityGuardMaxRetries(value: number | undefined): number {
  return clampNonNegativeInt(
    value,
    DEFAULT_QUALITY_GUARD_MAX_RETRIES,
    MAX_QUALITY_GUARD_MAX_RETRIES,
  );
}

function formatGeneratedSplitTurnSection(summary: string, onTruncated: () => void): string {
  const heading = `${SPLIT_TURN_SECTION_HEADING}\n\n`;
  const summaryBudget = MAX_SPLIT_TURN_CONTEXT_CHARS - heading.length;
  const nestedSummary = nestMarkdownHeadings(summary);
  const cappedSummary = capCompactionSummary(nestedSummary, summaryBudget);
  if (cappedSummary.length < nestedSummary.length) {
    onTruncated();
  }
  return `${heading}${cappedSummary}`;
}

/** Registers compaction hooks that summarize, preserve recent turns, and audit output quality. */
export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const {
      preparation,
      customInstructions: eventInstructions,
      signal,
      thinkingLevel,
      streamFn,
    } = event;
    const previousSummary = normalizeLegacySplitTurnSummary(preparation.previousSummary?.trim());
    const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
    const recentTurnsPreserve = resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve);
    const qualityGuardEnabled = runtime?.qualityGuardEnabled ?? false;
    const { requestSelection, latestUnresolvedUserRequest } = preparation;
    const reconcileRequestSelection = (summary: string) =>
      requestSelection?.state === "none" ? clearCompactionPendingAskSection(summary) : summary;
    setCompactionSafeguardCancellation(ctx.sessionManager, undefined);
    const cancelCompaction = (reason: string, error?: unknown) => {
      setCompactionSafeguardCancellation(ctx.sessionManager, reason, error);
      return { cancel: true as const };
    };
    const bounded = getPreparedCompaction(ctx.sessionManager);
    let rawSource: ReturnType<typeof prepareCompactionSafeguardSource> | undefined;
    let source: Omit<
      ReturnType<typeof prepareCompactionSafeguardSource>,
      "history" | "turnPrefix" | "reconciliation"
    >;
    try {
      rawSource = bounded
        ? undefined
        : prepareCompactionSafeguardSource({
            history: arraySafeguardSource(preparation.messagesToSummarize),
            turnPrefix: arraySafeguardSource(preparation.turnPrefixMessages ?? []),
            preparationRange: () =>
              arraySafeguardSource(
                collectPreparationRangeMessages(ctx.sessionManager, preparation.firstKeptEntryId),
              ),
            currentContext: () => projectBranchEntries(readSessionBranch(ctx.sessionManager)),
            isSplitTurn: preparation.isSplitTurn,
            previousSummary,
            requestSelection,
            latestUnresolvedUserRequest,
            recentTurnsPreserve,
            qualityGuardEnabled,
          });
      source = bounded ? bounded.safeguard : rawSource!;
      if (source.usedRangeFallback) {
        log.info(
          "Compaction safeguard: summarizing the boundary-scoped preparation range after compaction preparation omitted real conversation content.",
        );
      }
    } catch (error) {
      log.warn(
        `Compaction safeguard: session history inspection failed; preserving history: ${formatErrorMessage(error)}`,
      );
      return cancelCompaction("session history inspection failed", error);
    }
    if (!source.hasRealConversation) {
      // Canceling an empty preparation re-triggers compaction on the next response (#41981).
      // A compaction boundary suppresses immediate retries until another assistant turn.
      log.info(
        "Compaction safeguard: no real conversation messages to summarize; writing compaction boundary to suppress re-trigger loop.",
      );
      const fallbackSummary = buildStructuredFallbackSummary(previousSummary);
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        },
      };
    }
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const { toolFailureSection } = source;
    const baseMessagesToSummarize = rawSource ? materializeSafeguardSource(rawSource.history) : [];

    const customInstructions = resolveCompactionInstructions(
      eventInstructions,
      runtime?.customInstructions,
    );
    const summarizationInstructions = {
      identifierPolicy: runtime?.identifierPolicy,
      identifierInstructions: runtime?.identifierInstructions,
    };
    const identifierPolicy = runtime?.identifierPolicy ?? "strict";
    const providerId = runtime?.provider;
    const turnPrefixMessages = rawSource ? materializeSafeguardSource(rawSource.turnPrefix) : [];
    const structuredInstructions = buildCompactionStructureInstructions(
      customInstructions,
      summarizationInstructions,
      latestUnresolvedUserRequest,
    );
    let workspaceContextPromise: Promise<string> | undefined;
    const finalizeSummaryText = async (
      body: string,
      sections: {
        splitTurnSection?: ContextSection;
        generatedSplitTurnSection?: string;
        preservedTurnsSection?: ContextSection;
      },
      producerLosses: ReadonlySet<CompactionLoss> = new Set(),
      qualityRetention?: SummaryQualityRetention,
    ) => {
      workspaceContextPromise ??= readWorkspaceContextForSummary(
        runtime?.postCompactionSections,
        runtime?.workspaceDir,
      );
      // Chronological, and the tail cap trims from the head: older verbatim
      // preserved turns yield before the split turn and the required sections.
      const parts = {
        preservedTurnsSection: sections.preservedTurnsSection,
        splitTurnSection: sections.splitTurnSection,
        generatedSplitTurnSection: sections.generatedSplitTurnSection,
        toolFailureSection,
        fileOpsSummary,
        workspaceContext: await workspaceContextPromise,
      };
      let text = "";
      const contextRanges: CompactionSuffix["contextRanges"] = [];
      for (const part of Object.values(parts)) {
        if (!part) {
          continue;
        }
        const section = typeof part === "string" ? part : part.text;
        if (!section) {
          continue;
        }
        const leadingTrim = text ? 0 : section.length - section.trimStart().length;
        const appended = leadingTrim > 0 ? section.slice(leadingTrim) : section;
        const start = text.length;
        text = appendSummarySection(text, section);
        if (typeof part !== "string") {
          contextRanges.push({
            start,
            end: start + appended.length,
            segmentStarts: part.segmentStarts
              .filter((segmentStart) => segmentStart >= leadingTrim)
              .map((segmentStart) => start + segmentStart - leadingTrim),
          });
        }
      }
      // Ensure leading separator so suffix does not merge with body (e.g. when body
      // ends without newline: "...## Exact identifiers## Tool Failures").
      if (text && !/^\s/.test(text)) {
        text = `\n\n${text}`;
        for (const range of contextRanges) {
          range.start += 2;
          range.end += 2;
          range.segmentStarts = range.segmentStarts.map((segmentStart) => segmentStart + 2);
        }
      }
      const suffix: CompactionSuffix = { text, contextRanges };
      const fit = (retention?: SummaryQualityRetention) =>
        fitCompactionSummary(preparation.summaryTokenBudget, (maxChars) =>
          budgetCompactionSummary(body, suffix, maxChars, retention),
        );
      let fitted = fit(qualityRetention);
      const losses = new Set(producerLosses);
      const qualityRetentionInfeasible = !fitted.ok && Boolean(qualityRetention);
      if (qualityRetention && !fitted.ok) {
        // The request context is bounded; identifiers are not. Shed the longest
        // identifiers first so one oversized URL cannot take the request with it.
        const { identifiers } = qualityRetention;
        const byLength = identifiers.toSorted((left, right) => left.length - right.length);
        for (let kept = byLength.length - 1; kept >= 0 && !fitted.ok; kept -= 1) {
          const keep = new Set(byLength.slice(0, kept));
          fitted = fit({
            ...qualityRetention,
            identifiers: identifiers.filter((identifier) => keep.has(identifier)),
          });
        }
        losses.add(fitted.ok ? "identifier-retention" : "quality-retention");
        if (!fitted.ok) {
          fitted = fit();
        }
      }
      if (!fitted.ok) {
        throw fitted.error;
      }
      const finalized = fitted.value;
      for (const section of Object.values(sections)) {
        if (typeof section !== "string" && section?.truncatedLoss) {
          losses.add(section.truncatedLoss);
        }
      }
      if (finalized.bodyTrimmed) {
        losses.add("summary-tail");
      }
      if (finalized.suffixTrimmed) {
        losses.add("suffix-head");
      }
      if (losses.size > 0) {
        log.warn(
          `Compaction safeguard: finalized artifact truncated; loss=${[...losses].join(",")}`,
        );
      }
      return { ...finalized, qualityRetentionInfeasible };
    };
    const compactionResult = (summary: string, provenance?: { qualityDegraded: true }) => ({
      compaction: {
        summary,
        firstKeptEntryId: preparation.firstKeptEntryId,
        tokensBefore: preparation.tokensBefore,
        details: {
          readFiles,
          modifiedFiles,
          ...(latestUnresolvedUserRequest ? { latestUnresolvedUserRequest } : {}),
          ...provenance,
        },
      },
    });
    if (providerId) {
      const compactionProvider: CompactionProvider | undefined = getCompactionProvider(providerId);
      if (compactionProvider) {
        try {
          // Give the provider ALL messages — no pruning, no chunking, no split-turn splitting.
          const providerResult = await compactionProvider.summarize({
            messages: [...baseMessagesToSummarize, ...turnPrefixMessages],
            signal,
            customInstructions: structuredInstructions,
            summarizationInstructions,
            previousSummary,
          });
          if (typeof providerResult === "string" && providerResult.trim()) {
            const finalized = await finalizeSummaryText(reconcileRequestSelection(providerResult), {
              splitTurnSection: preparation.isSplitTurn
                ? buildSplitTurnContextSection(turnPrefixMessages)
                : undefined,
              preservedTurnsSection: source.preservedTurnsSection,
            });
            return compactionResult(finalized.summary);
          }
          log.warn(
            `Compaction provider "${compactionProvider.id}" returned empty result, falling back to LLM.`,
          );
        } catch (err) {
          // Escaped hook errors fall through to raw core compaction. Keep provider-local
          // failures in the audited fallback unless the caller aborted.
          if (signal?.aborted) {
            throw err;
          }
          log.warn(`Compaction provider "${compactionProvider.id}" failed, falling back to LLM.`);
        }
      } else {
        log.warn(
          `Compaction provider "${providerId}" is configured but not registered. Falling back to LLM.`,
        );
      }
    }

    const model = ctx.model ?? runtime?.model;
    if (!model) {
      if (!missedModelWarningSessions.has(ctx.sessionManager)) {
        missedModelWarningSessions.add(ctx.sessionManager);
        log.warn(
          "[compaction-safeguard] Both ctx.model and runtime.model are undefined. " +
            "Compaction summarization will not run. This indicates extensionRunner.initialize() " +
            "was not called and model was not passed through runtime registry.",
        );
      }
      return cancelCompaction("Compaction safeguard could not resolve a summarization model.");
    }

    const authResult = await resolveModelAuth(ctx, model);
    if (!authResult.ok) {
      return cancelCompaction(authResult.reason);
    }
    try {
      const headers = buildCompactionSummaryHeaders({
        model,
        messages: baseMessagesToSummarize,
        headers: authResult.headers,
      });
      const usageSink: SessionModelUsageSink = (usage) =>
        recordSessionModelUsage(ctx.sessionManager, usage);
      const llmSummaryParams = {
        model,
        apiKey: authResult.apiKey ?? "",
        headers,
        signal,
        reserveTokens: resolveSummaryReserveTokens(preparation.settings.reserveTokens, model),
        summarizationInstructions,
        thinkingLevel,
        streamFn,
        usageSink,
      };
      const qualityGuardMaxRetries = resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries);

      const {
        latestUserAsk,
        latestAskInRetainedTurn,
        identifiers,
        requiredAskContext,
        preservedTurnsSection: preservedTurnsSectionLocal,
      } = source;
      const reconciliationMessages =
        bounded?.reconciliation ?? materializeSafeguardSource(rawSource!.reconciliation);

      let correctiveInstructions = "";
      const totalAttempts = qualityGuardEnabled ? qualityGuardMaxRetries + 1 : 1;
      let bestSummary: { summary: string; reasonCount: number } | undefined;
      const degrade = (summary: string, diagnostic: string) => {
        log.warn(
          `Compaction safeguard: ${diagnostic}; using degraded summary; ` +
            "reasonCode=quality_guard_degraded_fallback",
        );
        return compactionResult(summary, { qualityDegraded: true });
      };

      for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
        let splitTurnSectionLocal = "";
        let splitTurnSummaryLocal = "";
        let historySummary = "";
        const producerLosses = new Set<CompactionLoss>();
        try {
          historySummary =
            reconciliationMessages.length > 0
              ? await compactionSafeguardDeps.summarizeCompactionHistory({
                  ...llmSummaryParams,
                  messages: reconciliationMessages,
                  summaryPrompt: { kind: "custom", instructions: structuredInstructions },
                  customInstructions: correctiveInstructions,
                  previousSummary,
                })
              : buildStructuredFallbackSummary(previousSummary);

          historySummary = reconcileRequestSelection(historySummary);

          if (
            preparation.isSplitTurn &&
            (bounded?.turnPrefix.length ?? turnPrefixMessages.length) > 0
          ) {
            const splitTurnFocusLabel = "Additional context from /compact";
            const splitTurnFocus = wrapUntrustedInstructionBlock(
              splitTurnFocusLabel,
              customInstructions,
            );
            const prefixSummary = await compactionSafeguardDeps.summarizeCompactionHistory({
              ...llmSummaryParams,
              messages: bounded?.turnPrefix ?? turnPrefixMessages,
              summaryPrompt: { kind: "turn-prefix" },
              customInstructions: [splitTurnFocus, correctiveInstructions]
                .filter(Boolean)
                .join("\n\n"),
              previousSummary: undefined,
            });
            splitTurnSummaryLocal = prefixSummary;
            splitTurnSectionLocal = formatGeneratedSplitTurnSection(prefixSummary, () => {
              producerLosses.add("split-turn-tail");
            });
          }
        } catch (attemptError) {
          if (signal?.aborted) {
            signal.throwIfAborted();
          }
          if (bestSummary) {
            return degrade(
              bestSummary.summary,
              `corrective generation failed; attempt=${attempt + 1}`,
            );
          }
          throw attemptError;
        }
        const unbudgetedSummary = appendSummarySection(
          historySummary,
          splitTurnSectionLocal ? `\n\n${splitTurnSectionLocal}` : "",
        );
        const structuralSummary = qualityGuardEnabled ? historySummary : unbudgetedSummary;
        const finalized = await finalizeSummaryText(
          structuralSummary,
          {
            generatedSplitTurnSection:
              qualityGuardEnabled && splitTurnSectionLocal
                ? `\n\n${splitTurnSectionLocal}`
                : undefined,
            preservedTurnsSection: preservedTurnsSectionLocal,
          },
          producerLosses,
          qualityGuardEnabled
            ? {
                auditSummary: unbudgetedSummary,
                identifiers,
                latestAsk: latestUserAsk,
                latestAskInRetainedTurn,
                latestUnresolvedUserRequest,
                requiredAskContext,
                identifierPolicy,
              }
            : undefined,
        );

        if (!qualityGuardEnabled) {
          return compactionResult(finalized.summary);
        }
        const quality = auditSummaryQuality({
          summary: finalized.summary,
          structuralSummary: finalized.structuralSummary,
          sourceSummaries: [historySummary, splitTurnSummaryLocal].filter(Boolean),
          identifiers,
          latestAsk: latestUserAsk,
          latestUnresolvedUserRequest,
          retainedTurnSummary: latestAskInRetainedTurn ? splitTurnSummaryLocal : undefined,
          identifierPolicy,
        });
        if (quality.ok && !finalized.qualityRetentionInfeasible) {
          return compactionResult(finalized.summary);
        }
        const reasonCount = quality.reasons.length + Number(finalized.qualityRetentionInfeasible);
        if (!bestSummary || reasonCount < bestSummary.reasonCount) {
          // Keep generated facts even when their formatting fails the audit. The
          // previous summary is only a fallback for an empty generated body.
          const recovered = await finalizeSummaryText(
            buildStructuredFallbackSummary(historySummary.trim() || previousSummary),
            {
              generatedSplitTurnSection: splitTurnSectionLocal
                ? `\n\n${splitTurnSectionLocal}`
                : undefined,
              preservedTurnsSection: preservedTurnsSectionLocal,
            },
            producerLosses,
            {
              identifiers,
              latestAsk: latestUserAsk,
              latestAskInRetainedTurn,
              latestUnresolvedUserRequest,
              requiredAskContext,
              identifierPolicy,
            },
          );
          bestSummary = { summary: recovered.summary, reasonCount };
        }
        if (finalized.qualityRetentionInfeasible) {
          return degrade(
            bestSummary.summary,
            "required quality facts exceed finalized artifact budget",
          );
        }
        if (reconciliationMessages.length === 0 || attempt >= totalAttempts - 1) {
          const reasonCodes = [
            ...new Set(quality.reasons.map((reason) => reason.split(":", 1)[0])),
          ];
          return degrade(
            bestSummary.summary,
            "final quality attempt failed; " +
              `reasonCodes=${reasonCodes.join(",")} reasonCount=${quality.reasons.length}`,
          );
        }
        const reasons = quality.reasons.join(", ");
        const qualityFeedbackInstruction =
          identifierPolicy === "strict"
            ? "Fix all issues and include every required section with exact identifiers preserved."
            : "Fix all issues and include every required section while following the configured identifier policy.";
        const budgetInstruction = `Keep the complete summary body within ${finalized.bodyBudget} UTF-16 code units so the finalized artifact remains valid after required suffixes.`;
        const qualityFeedbackReasons = wrapUntrustedInstructionBlock(
          "Quality check feedback",
          `Previous summary failed quality checks (${reasons}).`,
        );
        correctiveInstructions = qualityFeedbackReasons
          ? `${qualityFeedbackInstruction}\n${budgetInstruction}\n\n${qualityFeedbackReasons}`
          : `${qualityFeedbackInstruction}\n${budgetInstruction}`;
      }

      throw new Error("Compaction safeguard exhausted summary attempts without a decision.");
    } catch (error) {
      return recoverCompactionSafeguardFailure(error, preparation, signal, ctx.sessionManager);
    }
  });
}

const testing = {
  setSummarizeCompactionHistoryForTest(next?: typeof summarizeCompactionHistory) {
    compactionSafeguardDeps.summarizeCompactionHistory = next ?? summarizeCompactionHistory;
  },
  splitPreservedRecentTurns,
  buildPreservedTurnsSection,
  buildCompactionStructureInstructions,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  capCompactionSummary,
  budgetCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
  SUMMARY_TRUNCATED_MARKER,
  CONTEXT_TRUNCATED_MARKER,
} as const;

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.compactionSafeguardTestApi")] =
    testing;
}
