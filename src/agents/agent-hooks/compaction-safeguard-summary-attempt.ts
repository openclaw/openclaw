import { computeAdaptiveChunkRatioWithWorker } from "../compaction-planning-worker.js";
import { SUMMARIZATION_OVERHEAD_TOKENS } from "../compaction.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  type CompactionLoss,
  type ContextSection,
  formatGeneratedSplitTurnSection,
} from "./compaction-safeguard-context.js";
import {
  appendSummarySection,
  auditSummaryQuality,
  buildStructuredFallbackSummary,
  wrapUntrustedInstructionBlock,
} from "./compaction-safeguard-quality.js";

type IdentifierPolicy = "strict" | "off" | "custom";

type SummaryPrompt = { kind: "custom"; instructions: string } | { kind: "turn-prefix" };

type SummaryQualityRetention = {
  auditSummary?: string;
  identifiers: string[];
  latestAsk: string | null;
  latestAskInRetainedTurn?: boolean;
  latestUnresolvedUserRequest?: string;
  requiredAskContext: string;
  identifierPolicy: IdentifierPolicy;
};

type FinalizedCompactionSummary = {
  summary: string;
  structuralSummary: string;
  bodyBudget: number;
  qualityRetentionInfeasible: boolean;
};

type PreparedCompactionSummary = {
  finalized: FinalizedCompactionSummary;
  historySummary: string;
  splitTurnSummary: string;
};

type PreparedSummaryAudit = ReturnType<typeof auditSummaryQuality>;

type PreparedSummaryInput = {
  messages: AgentMessage[];
  preservedTurnsSection: ContextSection;
};

type SummarizeRequest = {
  messages: AgentMessage[];
  maxChunkTokens: number;
  summaryPrompt: SummaryPrompt;
  customInstructions?: string;
  previousSummary?: string;
};

type FinalizeSummaryText = (
  body: string,
  sections: {
    generatedSplitTurnSection?: string;
    preservedTurnsSection?: ContextSection;
  },
  producerLosses: ReadonlySet<CompactionLoss>,
  qualityRetention?: SummaryQualityRetention,
) => Promise<FinalizedCompactionSummary>;

export function createCompactionSummaryAttemptRuntime(params: {
  signal?: AbortSignal;
  contextWindowTokens: number;
  turnPrefixMessages: AgentMessage[];
  isSplitTurn: boolean;
  customInstructions?: string;
  structuredInstructions: string;
  qualityGuardEnabled: boolean;
  effectivePreviousSummary?: string;
  identifiers: string[];
  latestUserAsk: string | null;
  splitUserAsk: string | null;
  latestUnresolvedUserRequest?: string | null;
  requiredAskContext: string;
  identifierPolicy: IdentifierPolicy;
  summarize: (request: SummarizeRequest) => Promise<string>;
  finalizeSummaryText: FinalizeSummaryText;
}) {
  const summarizePreparedInput = async (input: {
    sourceMessages: AgentMessage[];
    preservedTurnsSection: ContextSection;
    correctiveInstructions: string;
  }): Promise<PreparedCompactionSummary> => {
    const adaptiveRatio = await computeAdaptiveChunkRatioWithWorker({
      messages: [...input.sourceMessages, ...params.turnPrefixMessages],
      contextWindow: params.contextWindowTokens,
      signal: params.signal,
    });
    const maxChunkTokens = Math.max(
      1,
      Math.floor(params.contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
    );
    let splitTurnSection = "";
    let splitTurnSummary = "";
    const producerLosses = new Set<CompactionLoss>();
    const historySummary =
      input.sourceMessages.length > 0
        ? await params.summarize({
            messages: input.sourceMessages,
            maxChunkTokens,
            summaryPrompt: { kind: "custom", instructions: params.structuredInstructions },
            customInstructions: input.correctiveInstructions,
            previousSummary: params.effectivePreviousSummary,
          })
        : buildStructuredFallbackSummary(params.effectivePreviousSummary);

    if (params.isSplitTurn && params.turnPrefixMessages.length > 0) {
      const splitTurnFocus = wrapUntrustedInstructionBlock(
        "Additional context from /compact",
        params.customInstructions ?? "",
      );
      const prefixSummary = await params.summarize({
        messages: params.turnPrefixMessages,
        maxChunkTokens,
        summaryPrompt: { kind: "turn-prefix" },
        customInstructions: [splitTurnFocus, input.correctiveInstructions]
          .filter(Boolean)
          .join("\n\n"),
        previousSummary: undefined,
      });
      splitTurnSummary = prefixSummary;
      splitTurnSection = formatGeneratedSplitTurnSection(prefixSummary, () => {
        producerLosses.add("split-turn-tail");
      });
    }

    const unbudgetedSummary = appendSummarySection(
      historySummary,
      splitTurnSection ? `\n\n${splitTurnSection}` : "",
    );
    const structuralSummary = params.qualityGuardEnabled ? historySummary : unbudgetedSummary;
    const finalized = await params.finalizeSummaryText(
      structuralSummary,
      {
        generatedSplitTurnSection:
          params.qualityGuardEnabled && splitTurnSection ? `\n\n${splitTurnSection}` : undefined,
        preservedTurnsSection: input.preservedTurnsSection,
      },
      producerLosses,
      params.qualityGuardEnabled
        ? {
            auditSummary: unbudgetedSummary,
            identifiers: params.identifiers,
            latestAsk: params.latestUserAsk,
            latestAskInRetainedTurn: params.splitUserAsk !== null,
            latestUnresolvedUserRequest: params.latestUnresolvedUserRequest ?? undefined,
            requiredAskContext: params.requiredAskContext,
            identifierPolicy: params.identifierPolicy,
          }
        : undefined,
    );
    return { finalized, historySummary, splitTurnSummary };
  };

  const auditPreparedSummary = (candidate: PreparedCompactionSummary): PreparedSummaryAudit => {
    if (!params.qualityGuardEnabled) {
      return { ok: true, reasons: [] };
    }
    if (candidate.finalized.qualityRetentionInfeasible) {
      return { ok: false, reasons: ["quality-retention-infeasible"] };
    }
    return auditSummaryQuality({
      summary: candidate.finalized.summary,
      structuralSummary: candidate.finalized.structuralSummary,
      sourceSummaries: [candidate.historySummary, candidate.splitTurnSummary].filter(Boolean),
      identifiers: params.identifiers,
      latestAsk: params.latestUserAsk,
      latestUnresolvedUserRequest: params.latestUnresolvedUserRequest ?? undefined,
      retainedTurnSummary: params.splitUserAsk !== null ? candidate.splitTurnSummary : undefined,
      identifierPolicy: params.identifierPolicy,
    });
  };

  const buildCorrectiveInstructions = (input: {
    audit: PreparedSummaryAudit;
    bodyBudget: number;
  }): string => {
    const qualityFeedbackInstruction =
      params.identifierPolicy === "strict"
        ? "Fix all issues and include every required section with exact identifiers preserved."
        : "Fix all issues and include every required section while following the configured identifier policy.";
    const budgetInstruction = `Keep the complete summary body within ${input.bodyBudget} UTF-16 code units so the finalized artifact remains valid after required suffixes.`;
    const qualityFeedbackReasons = wrapUntrustedInstructionBlock(
      "Quality check feedback",
      `Previous summary failed quality checks (${input.audit.reasons.join(", ")}).`,
    );
    return qualityFeedbackReasons
      ? `${qualityFeedbackInstruction}\n${budgetInstruction}\n\n${qualityFeedbackReasons}`
      : `${qualityFeedbackInstruction}\n${budgetInstruction}`;
  };

  const buildUncuratedFallback = async (input: {
    sourceMessages: AgentMessage[];
    prepareInput: (messages: AgentMessage[]) => PreparedSummaryInput;
  }): Promise<{ status: "ok"; summary: string } | { status: "failed"; reason: string }> => {
    try {
      params.signal?.throwIfAborted();
      const prepared = input.prepareInput(input.sourceMessages);
      const candidate = await summarizePreparedInput({
        sourceMessages: prepared.messages,
        preservedTurnsSection: prepared.preservedTurnsSection,
        correctiveInstructions: "",
      });
      params.signal?.throwIfAborted();
      const audit = auditPreparedSummary(candidate);
      return audit.ok
        ? { status: "ok", summary: candidate.finalized.summary }
        : {
            status: "failed",
            reason: `deterministic-quality:${audit.reasons.join(",")}`,
          };
    } catch (error) {
      params.signal?.throwIfAborted();
      return {
        status: "failed",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  return {
    summarizePreparedInput,
    auditPreparedSummary,
    buildCorrectiveInstructions,
    buildUncuratedFallback,
  };
}
