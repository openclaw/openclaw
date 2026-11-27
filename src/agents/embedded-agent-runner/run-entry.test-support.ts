import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { runWithModelFallback } from "../model-fallback-runner.js";
import type { EmbeddedAgentRunResult } from "./types.js";

export {
  initialModelFallbackAttemptOptions as initialAttemptOptions,
  fallbackModelAttemptOptions as fallbackAttemptOptions,
} from "../test-helpers/model-fallback-runner.test-support.js";

export type FallbackRunnerParams = Parameters<
  typeof runWithModelFallback<EmbeddedAgentRunResult>
>[0];

export function recordTurnAttempt(
  record: ((facts: ContextEngineTurnAttemptFacts) => void) | undefined,
  label: string,
): void {
  if (!record) {
    throw new Error("expected context-engine turn candidate callback");
  }
  const owner = {
    agentId: "main",
    sessionId: label,
    sessionKey: `agent:main:${label}`,
    storePath: `/${label}.sqlite`,
    generation: "generation-1",
  };
  record({
    boundary: {
      admission: {
        ...owner,
        entryId: `${label}-user`,
        rawSeq: 1,
        effectiveParentId: null,
        activeMessagePosition: 0,
        logicalTurnId: `${label}-turn`,
        role: "user",
      },
      terminal: {
        ...owner,
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

export function makeResult(params: {
  provider: string;
  model: string;
  sessionId?: string;
  text?: string;
  classification?: "empty";
  meta?: Partial<EmbeddedAgentRunResult["meta"]>;
}): EmbeddedAgentRunResult {
  const { provider, model, classification, meta } = params;
  return {
    payloads: classification ? [] : [{ text: params.text ?? "recovered" }],
    meta: {
      durationMs: 10,
      aborted: false,
      providerStarted: true,
      stopReason: "completed",
      agentHarnessResultClassification: classification,
      agentMeta: { sessionId: params.sessionId ?? "session-1", provider, model },
      ...meta,
    },
  };
}

export function createDirectHarness(workspaceDir = "/tmp/workspace", runtime?: string) {
  return {
    workspaceDir,
    preparation: { kind: "direct" as const },
    resolveRuntimeOverride: () => runtime,
  };
}
