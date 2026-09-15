import type { FailoverReason } from "../failover/signal.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackRunOptions } from "../model-fallback-attempt.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export type FallbackRunnerParams = Parameters<
  typeof runWithModelFallback<EmbeddedAgentRunResult>
>[0];

export function initialAttemptOptions(params: FallbackRunnerParams): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "initial",
    },
  };
}

export function fallbackAttemptOptions(
  params: FallbackRunnerParams,
  fallbackReason: FailoverReason,
): ModelFallbackRunOptions {
  return {
    modelRoutingProvenance: {
      requestedProvider: params.provider,
      requestedModel: params.model,
      stage: "fallback",
      fallbackReason,
    },
  };
}

export function recordTurnAttempt(
  record: ((facts: ContextEngineTurnAttemptFacts) => void) | undefined,
  label: string,
): void {
  if (!record) {
    throw new Error("expected context-engine turn candidate callback");
  }
  record({
    boundary: {
      admission: {
        agentId: "main",
        sessionId: label,
        sessionKey: `agent:main:${label}`,
        storePath: `/${label}.sqlite`,
        generation: "generation-1",
        entryId: `${label}-user`,
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: `${label}-turn`,
        role: "user",
      },
      terminal: {
        agentId: "main",
        sessionId: label,
        sessionKey: `agent:main:${label}`,
        storePath: `/${label}.sqlite`,
        generation: "generation-1",
        entryId: `${label}-assistant`,
        rawSeq: 2,
        effectiveParentId: `${label}-user`,
        activeMessagePosition: 1,
      },
    },
    sessionIdUsed: label,
    promptError: false,
    aborted: false,
    yieldAborted: false,
  });
}
