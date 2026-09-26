import { evaluateDecision } from "../../decisions/runtime.js";
import { DecisionConsumerClosedError } from "../../decisions/validation.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  buildPreservedTurnsSection,
  type ContextSection,
  extractLatestUserAsk,
  splitPreservedRecentTurns,
} from "./compaction-safeguard-context.js";
import { getCurrentCompactionSemanticMode } from "./compaction-safeguard-runtime.js";
import {
  evaluateCompactionFidelity,
  evaluateCompactionShadowCuration,
} from "./compaction-safeguard-semantic-decisions.js";
import {
  buildCompactionSemanticSnapshot,
  fingerprint,
  fingerprintCompactionMessages,
  projectCompactionSemanticSelection,
  type CompactionSemanticSnapshot,
} from "./compaction-safeguard-semantic.js";

export type ActiveCompactionCuration = {
  messages: AgentMessage[];
  snapshot?: CompactionSemanticSnapshot;
  uncuratedMessages?: AgentMessage[];
  omittedSegmentIds?: string[];
  applied?: {
    sourceMessages: number;
    selectedMessages: number;
    originalChars: number;
    selectedChars: number;
    reductionRatio: number;
    providerId: string;
  };
  skippedReason?: string;
};

export async function prepareActiveCompactionCuration(params: {
  sessionManager: unknown;
  agentId?: string;
  mode: "off" | "shadow" | "apply";
  sourceMessages: AgentMessage[];
  recentTurnsPreserve: number;
  identifiers: string[];
  latestUnresolvedUserRequest?: string | null;
  latestUserAsk?: string | null;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<ActiveCompactionCuration> {
  if (
    params.mode !== "apply" ||
    getCurrentCompactionSemanticMode(params.sessionManager) !== "apply"
  ) {
    return { messages: params.sourceMessages, skippedReason: "not-apply-mode" };
  }
  const { preservedMessages } = splitPreservedRecentTurns({
    messages: params.sourceMessages,
    recentTurnsPreserve: params.recentTurnsPreserve,
  });
  const snapshot = buildCompactionSemanticSnapshot({
    messages: params.sourceMessages,
    protectedMessages: new Set(preservedMessages),
    identifiers: params.identifiers,
    latestUnresolvedUserRequest: params.latestUnresolvedUserRequest,
    latestUserAsk: params.latestUserAsk,
  });
  let selection: Awaited<ReturnType<typeof evaluateCompactionShadowCuration>>;
  try {
    selection = await evaluateCompactionShadowCuration({
      runtime: { evaluate: evaluateDecision },
      agentId: params.agentId,
      snapshot,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      isEligible: () => getCurrentCompactionSemanticMode(params.sessionManager) === "apply",
    });
  } catch (error) {
    params.signal.throwIfAborted();
    if (error instanceof DecisionConsumerClosedError) {
      throw error;
    }
    return { messages: params.sourceMessages, skippedReason: "selection-error" };
  }
  params.signal.throwIfAborted();
  if (getCurrentCompactionSemanticMode(params.sessionManager) !== "apply") {
    return { messages: params.sourceMessages, skippedReason: "mode-changed" };
  }
  const projected = projectCompactionSemanticSelection({
    messages: params.sourceMessages,
    snapshot,
    selection,
  });
  if (!projected || projected.length >= params.sourceMessages.length) {
    return {
      messages: params.sourceMessages,
      skippedReason:
        selection.status === "ok"
          ? selection.complete
            ? "no-reduction"
            : "incomplete-or-uncertain-selection"
          : `${selection.status}:${selection.reason}`,
    };
  }
  if (selection.status !== "ok") {
    return { messages: params.sourceMessages, skippedReason: "selection-unavailable" };
  }
  return {
    messages: projected,
    snapshot,
    uncuratedMessages: params.sourceMessages,
    omittedSegmentIds: selection.excludedSegmentIds,
    applied: {
      sourceMessages: params.sourceMessages.length,
      selectedMessages: projected.length,
      originalChars: selection.originalChars,
      selectedChars: selection.selectedChars,
      reductionRatio: selection.reductionRatio,
      providerId: selection.provenance.providerId,
    },
  };
}

export function prepareCompactionSummaryInput(params: {
  sourceMessages: AgentMessage[];
  recentTurnsPreserve: number;
  qualityGuardEnabled: boolean;
  latestUnresolvedUserRequest?: string | null;
  latestUserAsk?: string | null;
  requiredAskContext: string;
}): { messages: AgentMessage[]; preservedTurnsSection: ContextSection } {
  const { summarizableMessages, preservedMessages } = splitPreservedRecentTurns({
    messages: params.sourceMessages,
    recentTurnsPreserve: params.recentTurnsPreserve,
  });
  const preservedTurnsSection = buildPreservedTurnsSection(preservedMessages);
  const latestPreparedAskText = extractLatestUserAsk(params.sourceMessages) ?? "";
  const includePreservedContext =
    !params.latestUnresolvedUserRequest &&
    params.qualityGuardEnabled &&
    latestPreparedAskText === params.latestUserAsk &&
    Boolean(latestPreparedAskText) &&
    (summarizableMessages.length > 0 ||
      !preservedTurnsSection.text.includes(params.requiredAskContext));
  return {
    messages: includePreservedContext ? params.sourceMessages : summarizableMessages,
    preservedTurnsSection,
  };
}

export type CuratedCandidateResolution =
  | { status: "accepted"; summary: string; usedFallback: false }
  | { status: "accepted"; summary: string; usedFallback: true; reason: string }
  | { status: "rejected"; reason: string };

export async function resolveCuratedCompactionCandidate(params: {
  sessionManager: unknown;
  agentId?: string;
  snapshot?: CompactionSemanticSnapshot;
  uncuratedMessages?: AgentMessage[];
  omittedSegmentIds?: readonly string[];
  summary: string;
  signal: AbortSignal;
  timeoutMs?: number;
  buildUncuratedFallback: () => Promise<string | null>;
}): Promise<CuratedCandidateResolution> {
  params.signal.throwIfAborted();
  if (!params.snapshot) {
    return { status: "accepted", summary: params.summary, usedFallback: false };
  }
  if (
    getCurrentCompactionSemanticMode(params.sessionManager) !== "apply" ||
    !params.uncuratedMessages ||
    fingerprintCompactionMessages(params.uncuratedMessages) !== params.snapshot.sourceFingerprint
  ) {
    const fallback = await params.buildUncuratedFallback();
    return fallback
      ? {
          status: "accepted",
          summary: fallback,
          usedFallback: true,
          reason: "stale-source-or-mode",
        }
      : { status: "rejected", reason: "stale-source-or-mode" };
  }

  let reason: string;
  let fidelity: Awaited<ReturnType<typeof evaluateCompactionFidelity>>;
  try {
    fidelity = await evaluateCompactionFidelity({
      runtime: { evaluate: evaluateDecision },
      agentId: params.agentId,
      snapshot: params.snapshot,
      candidateSummary: params.summary,
      omittedSegmentIds: params.omittedSegmentIds,
      signal: params.signal,
      timeoutMs: params.timeoutMs,
      isEligible: () => getCurrentCompactionSemanticMode(params.sessionManager) === "apply",
    });
  } catch (error) {
    params.signal.throwIfAborted();
    if (error instanceof DecisionConsumerClosedError) {
      throw error;
    }
    const fallback = await params.buildUncuratedFallback();
    return fallback
      ? { status: "accepted", summary: fallback, usedFallback: true, reason: "fidelity-error" }
      : { status: "rejected", reason: "fidelity-error" };
  }
  params.signal.throwIfAborted();
  if (fidelity.status !== "ok") {
    reason = `fidelity-${fidelity.status}:${fidelity.reason}`;
  } else if (
    getCurrentCompactionSemanticMode(params.sessionManager) !== "apply" ||
    fingerprintCompactionMessages(params.uncuratedMessages) !== params.snapshot.sourceFingerprint ||
    fidelity.sourceFingerprint !== params.snapshot.sourceFingerprint ||
    fidelity.candidateFingerprint !== fingerprint(params.summary)
  ) {
    reason = "fidelity-stale";
  } else if (
    fidelity.assessments.length > 0 &&
    fidelity.assessments.every((assessment) => assessment.classification === "preserved")
  ) {
    return { status: "accepted", summary: params.summary, usedFallback: false };
  } else {
    reason = "fidelity-non-preserved";
  }

  const fallback = await params.buildUncuratedFallback();
  return fallback
    ? { status: "accepted", summary: fallback, usedFallback: true, reason }
    : { status: "rejected", reason };
}
