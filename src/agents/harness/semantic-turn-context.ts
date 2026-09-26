import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AssembleResult } from "../../context-engine/types.js";
import { evaluateDecision } from "../../decisions/runtime.js";
import type { DecisionRuntimeV1 } from "../../decisions/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { evaluateCompactionShadowCuration } from "../agent-hooks/compaction-safeguard-semantic-decisions.js";
import {
  buildCompactionSemanticSnapshot,
  fingerprintCompactionMessages,
} from "../agent-hooks/compaction-safeguard-semantic.js";
import type { AgentMessage } from "../runtime/index.js";

const log = createSubsystemLogger("agents/semantic-context");
export type SemanticTurnContextOptions = {
  config?: AgentDefaultsConfig["turnContextCuration"];
  signal: AbortSignal;
  assertActive: () => void;
  /** Live eligibility bound to the prepared config owner, not provider readiness. */
  isEligible: () => boolean;
  prompt?: string;
  agentId?: string;
  appendOnly?: boolean;
};

/** Observe the existing context engine's view; never persist or replace its messages. */
export async function observeSemanticTurnContext(
  assembled: AssembleResult,
  options: SemanticTurnContextOptions,
  runtime: DecisionRuntimeV1 = { evaluate: evaluateDecision },
): Promise<AssembleResult> {
  if (!options.config || options.config.mode !== "shadow") {
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
  const recentStart = Math.max(0, messages.length - (options.config.recentMessages ?? 4));
  const protectedMessages = new Set(
    messages.filter(
      (message, index) =>
        index >= recentStart ||
        message.role === "user" ||
        (message.role === "toolResult" && message.isError) ||
        (message.role === "assistant" &&
          message.content.some((part) => part.type !== "toolCall")) ||
        (message.role !== "assistant" && message.role !== "toolResult"),
    ),
  );
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
  const snapshot = buildCompactionSemanticSnapshot({ messages, protectedMessages, latestUserAsk });
  const estimatedTokens = Math.ceil(snapshot.originalChars / 4);
  const observe = (
    reason: string,
    details: Partial<NonNullable<AssembleResult["semanticCurationObservation"]>> = {},
  ) => {
    const observation: NonNullable<AssembleResult["semanticCurationObservation"]> = {
      mode: "shadow",
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
  const started = performance.now();
  let selection: Awaited<ReturnType<typeof evaluateCompactionShadowCuration>>;
  try {
    selection = await evaluateCompactionShadowCuration({
      runtime,
      snapshot,
      agentId: options.agentId,
      signal: options.signal,
      timeoutMs: options.config.timeoutMs,
      isEligible: options.isEligible,
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
  if (before !== fingerprintCompactionMessages(assembled.messages)) {
    return observe("stale-source", { decisionWallMs });
  }
  if (selection.status !== "ok") {
    return observe(selection.reason, { decisionWallMs });
  }
  return observe(selection.complete ? "shadow" : "incomplete-selection", {
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
}
