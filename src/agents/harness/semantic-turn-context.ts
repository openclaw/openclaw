import {
  classifyToolUseResultPairing,
  isSyntheticMissingToolResult,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AssembleResult } from "../../context-engine/types.js";
import { evaluateDecision } from "../../decisions/runtime.js";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateCompactionShadowCuration } from "../agent-hooks/compaction-safeguard-semantic-decisions.js";
import {
  buildCompactionSemanticSnapshot,
  fingerprintCompactionMessages,
  fingerprint,
} from "../agent-hooks/compaction-safeguard-semantic.js";
import type { AgentMessage } from "../runtime/index.js";
import { resolveTurnCurationPolicy } from "./semantic-turn-context-policy.js";

const log = createSubsystemLogger("agents/semantic-context");
export type SemanticTurnContextOptions = {
  config?: AgentDefaultsConfig["turnContextCuration"];
  signal: AbortSignal;
  assertActive: () => void;
  /** Live eligibility bound to the prepared config owner, not provider readiness. */
  isEligible: () => boolean;
  prompt?: string;
  agentId?: string;
  modelId?: string;
  appendOnly?: boolean;
};

/** Curate only a temporary execution view; never mutate the engine's messages. */
export async function observeSemanticTurnContext(
  assembled: AssembleResult,
  options: SemanticTurnContextOptions,
  runtime: DecisionRuntimeV1 = { evaluate: evaluateDecision },
): Promise<AssembleResult> {
  if (!options.config || (options.config.mode !== "shadow" && options.config.mode !== "apply")) {
    return assembled;
  }
  options.signal.throwIfAborted();
  options.assertActive();
  if (!options.isEligible()) {
    return assembled;
  }
  // A distinct synthetic current user message informs selection without modifying
  // the engine result. Source indexes still address the original prefix.
  const messages: AgentMessage[] = [...assembled.messages];
  if (options.prompt?.trim()) {
    messages.push({ role: "user", content: options.prompt, timestamp: 0 });
  }
  const before = fingerprintCompactionMessages(assembled.messages);
  const apply = options.config.mode === "apply";
  const policy = apply
    ? resolveTurnCurationPolicy(assembled, options.config, options.modelId)
    : undefined;
  const recentStart = Math.max(0, assembled.messages.length - (options.config.recentMessages ?? 4));
  const protectedMessages = new Set(
    messages.filter(
      (message, index) =>
        (apply && !policy?.discretionary.has(index)) ||
        index >= recentStart ||
        message.role === "user" ||
        (message.role === "toolResult" && message.isError) ||
        (message.role === "assistant" &&
          message.content.some((part) => part.type !== "toolCall")) ||
        (message.role !== "assistant" && message.role !== "toolResult"),
    ),
  );
  // A discretionary hint cannot authorize dropping an unfinished operation.
  // Pairing is occurrence-aware: repeated provider ids are not conflated.
  for (const frame of classifyToolUseResultPairing(messages, { preserveUnframedToolResults: true })
    .frames) {
    if (
      frame.failed ||
      frame.occurrences.some(
        (occurrence) =>
          !occurrence.sourceResult || isSyntheticMissingToolResult(occurrence.sourceResult),
      )
    ) {
      protectedMessages.add(frame.assistant);
    }
  }
  const latestUser = messages.toReversed().find((message) => message.role === "user");
  const latestUserAsk =
    latestUser?.role === "user"
      ? typeof latestUser.content === "string"
        ? latestUser.content
        : latestUser.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n")
      : undefined;
  const snapshot = buildCompactionSemanticSnapshot({
    messages,
    protectedMessages,
    latestUserAsk,
    identifiers: policy?.requiredIdentifiers,
  });
  const estimatedTokens = Math.ceil(snapshot.originalChars / 4);
  const observe = (
    reason: string,
    details: Partial<NonNullable<AssembleResult["semanticCurationObservation"]>> = {},
  ) => {
    const observation: NonNullable<AssembleResult["semanticCurationObservation"]> = {
      mode: options.config!.mode === "apply" ? "apply" : "shadow",
      ...(apply ? { applied: false } : {}),
      reason,
      sourceChars: snapshot.originalChars,
      selectedChars: snapshot.originalChars,
      sourceEstimatedTokens: estimatedTokens,
      selectedEstimatedTokens: estimatedTokens,
      reductionRatio: 0,
      protectedSegments: snapshot.segments.filter((segment) => segment.protected).length,
      evaluatedSegments: 0,
      uncertainSegments: 0,
      decisionWallMs: 0,
      ...details,
    };
    // No source text, tool arguments, identifiers, or source digests in routine logs.
    log.debug("turn context curation", observation);
    return { ...assembled, semanticCurationObservation: observation };
  };
  if (estimatedTokens < (options.config.minEstimatedTokens ?? 16_000)) {
    return observe("below-size-threshold");
  }
  if (options.appendOnly || assembled.contextProjection?.mode === "thread_bootstrap") {
    return observe("persistent-or-append-only-context");
  }
  if (!snapshot.complete) {
    return observe("incomplete-source");
  }
  if (apply && !policy) {
    return observe("missing-owner-or-economics");
  }
  if (policy) {
    const possibleTokens = Math.floor(
      snapshot.segments
        .filter((segment) => !segment.protected)
        .reduce((total, segment) => total + segment.originalChars, 0) / 4,
    );
    if (
      possibleTokens * policy.savedMsPerEstimatedToken <=
      policy.overheadMs + policy.cachePenaltyMs
    ) {
      return observe("uneconomic-before-decision");
    }
  }
  const started = performance.now();
  let selection: Awaited<ReturnType<typeof evaluateCompactionShadowCuration>>;
  try {
    selection = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      isEligible: () => {
        // Provider preparation awaits plugin authority. A closed run must not
        // send its evidence even when configuration consent remains enabled.
        options.assertActive();
        return options.isEligible();
      },
      agentId: options.agentId,
      signal: options.signal,
      timeoutMs: options.config.timeoutMs,
      ...(apply ? { minDropProbability: options.config.minDropProbability ?? 0.95 } : {}),
    });
  } catch {
    // Optional observation cannot fail a model turn, but caller cancellation
    // and replaced run authority must still escape rather than becoming fallback.
    options.signal.throwIfAborted();
    options.assertActive();
    if (!options.isEligible()) {
      return assembled;
    }
    return observe("decision-error", { decisionWallMs: performance.now() - started });
  }
  options.signal.throwIfAborted();
  options.assertActive();
  if (!options.isEligible()) {
    return assembled;
  }
  const decisionWallMs = performance.now() - started;
  if (
    before !== fingerprintCompactionMessages(assembled.messages) ||
    (policy &&
      (!assembled.semanticCurationCandidates ||
        policy.fingerprint !== fingerprint(assembled.semanticCurationCandidates)))
  ) {
    return observe("stale-source", { decisionWallMs });
  }
  if (selection.status !== "ok") {
    return observe(selection.reason, { decisionWallMs });
  }
  const observed = observe(selection.complete ? "shadow" : "incomplete-selection", {
    selectedChars: selection.selectedChars,
    selectedEstimatedTokens: Math.ceil(selection.selectedChars / 4),
    reductionRatio: selection.reductionRatio,
    evaluatedSegments: selection.evaluatedSegmentIds.length,
    uncertainSegments: selection.uncertainSegmentIds.length,
    decisionWallMs,
    ...(selection.usage?.inputTokens !== undefined
      ? { decisionInputTokens: selection.usage.inputTokens }
      : {}),
    ...(selection.usage?.outputTokens !== undefined
      ? { decisionOutputTokens: selection.usage.outputTokens }
      : {}),
  });
  if (!apply || !policy || !selection.complete) {
    return observed;
  }
  const savedTokens = Math.floor((snapshot.originalChars - selection.selectedChars) / 4);
  const projectedNetSavingsMs =
    savedTokens * policy.savedMsPerEstimatedToken -
    Math.max(policy.overheadMs, decisionWallMs) -
    policy.cachePenaltyMs;
  if (savedTokens <= 0 || projectedNetSavingsMs <= 0) {
    return observe("uneconomic-selection", { decisionWallMs, projectedNetSavingsMs });
  }
  const excluded = new Set(selection.excludedSegmentIds);
  const omittedIndexes = new Set(
    snapshot.segments
      .filter((segment) => excluded.has(segment.id))
      .flatMap((segment) => segment.sourceIndexes),
  );
  return {
    ...observed,
    // Keep the engine's conservative token upper bound; a chars/4 estimate must
    // not weaken overflow admission. Only the temporary message view shrinks.
    messages: assembled.messages.filter((_, index) => !omittedIndexes.has(index)),
    semanticCurationCandidates: undefined,
    semanticCurationObservation: {
      ...observed.semanticCurationObservation!,
      reason: "applied",
      applied: true,
      projectedNetSavingsMs,
    },
  };
}
