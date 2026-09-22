import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngineHostSupport } from "../../context-engine/host-compat.js";
import type { PreparedAgentRunAdmission } from "../admitted-run-context.js";
import type { AssistantErrorTranscript } from "../assistant-error-transcript.js";
import type { ContextEngineLogicalTurnLease } from "../harness/context-engine-logical-turn.js";
import type { ContextEngineTurnAttemptFacts } from "../harness/context-engine-turn-attempt.js";
import type { ModelFallbackResultClassification } from "../model-fallback-attempt.js";
import type { ModelFallbackStepFields } from "../model-fallback-observation.js";
import type {
  FallbackAttempt,
  ModelFallbackAttemptProvenance,
  ModelFallbackRouteResolution,
} from "../model-fallback.types.js";
import type { ModelManifestNormalizationContext } from "../model-ref-shared.js";
import type { QuotaContinuation } from "./quota-continuation.js";
import type {
  EmbeddedAgentRunEntryTerminal,
  RunEntryTerminalBehavior,
} from "./run-entry-terminal.js";
import type { AuthProfileFailurePolicy } from "./run/auth-profile-failure-policy.types.js";
import type { createQuotaContinuationBudget } from "./run/quota-continuation-budget.js";
import type { EmbeddedAgentRunResult } from "./types.js";

type RunEntryCandidateOptions = {
  agentHarnessRuntimeOverride: string | undefined;
  quotaContinuation?: QuotaContinuation;
  quotaBudget?: ReturnType<typeof createQuotaContinuationBudget>;
  assistantErrorTranscript: AssistantErrorTranscript;
  authProfileFailurePolicy?: AuthProfileFailurePolicy;
  classifyResult: (result: EmbeddedAgentRunResult) => ModelFallbackResultClassification;
  allowTransientCooldownProbe?: boolean;
  isFinalFallbackAttempt?: boolean;
  isFallbackRetry: boolean;
  modelRoutingProvenance: ModelFallbackAttemptProvenance;
  contextEngineLogicalTurnLease: ContextEngineLogicalTurnLease;
  onContextEngineTurnCandidate: (facts: ContextEngineTurnAttemptFacts) => void;
};

export type RunEntryCandidate<T> = {
  result: T;
  classification?: ModelFallbackResultClassification;
  turnAttempt?: ContextEngineTurnAttemptFacts;
};

type RunEntryHarnessPreparation =
  | { kind: "direct" }
  | {
      kind: "measured";
      run: (prepare: () => Promise<void>) => Promise<void>;
    };

type RunEntryBehavior = RunEntryTerminalBehavior;

type RunEntrySessionOverride =
  | { kind: "preserve" }
  | {
      kind: "reconcile-completed";
      reconcile: (candidate: { provider: string; model: string }) => Promise<void>;
    };

export type EmbeddedAgentRunEntryResult<T extends EmbeddedAgentRunResult> = {
  outcome: "completed" | "exhausted";
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  terminal: EmbeddedAgentRunEntryTerminal;
  settleSessionOverride: () => Promise<void>;
};

export type EmbeddedAgentRunEntryParams<T extends EmbeddedAgentRunResult> = {
  preparedRunAdmission?: PreparedAgentRunAdmission;
  selection: {
    cfg: OpenClawConfig;
    provider: string;
    model: string;
    requestedRouteResolution?: ModelFallbackRouteResolution;
    fallbacksOverride?: string[];
    agentDir?: string;
    userLockedAuthProfileId?: string;
  } & ModelManifestNormalizationContext;
  identity: {
    runId: string;
    agentId: string;
    sessionId: string;
    sessionKey?: string;
    lane?: string;
  };
  harness: {
    workspaceDir: string;
    sessionKey?: string;
    preparation: RunEntryHarnessPreparation;
    resolveRuntimeOverride: (provider: string, model: string) => string | undefined;
    resolveContextEngineHost?: (
      provider: string,
      model: string,
      agentHarnessRuntimeOverride: string | undefined,
    ) => ContextEngineHostSupport | undefined;
  };
  behavior: RunEntryBehavior;
  sessionOverride: RunEntrySessionOverride;
  abortSignal?: AbortSignal;
  onFallbackStep?: (step: ModelFallbackStepFields) => void | Promise<void>;
  /** Runs once after the successful winner is accepted, before post-turn context commit. */
  onAcceptedTerminal?: () => void | (() => void) | Promise<void | (() => void)>;
  runCandidate: (provider: string, model: string, options: RunEntryCandidateOptions) => Promise<T>;
};
