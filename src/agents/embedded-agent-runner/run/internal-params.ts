import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import type { SessionAdmissionTransition } from "../../../config/sessions/session-admission-transition.types.js";
import type { PreparedSessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import type { SessionTranscriptTargetBinding } from "../../../config/sessions/transcript-target-binding.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { Model } from "../../../llm/types.js";
import type { ReplyMessageJoinObservation } from "../../../sessions/session-controller.message-join-observation.js";
import type { SessionControllerWatchdogAttempt } from "../../../sessions/session-controller.watchdog.js";
import type { PreparedTtsPreferences } from "../../../tts/tts-preferences.js";
import type { AgentExecutionAuthBinding } from "../../execution-auth-binding.js";
import type { ModelFallbackRouteResolution } from "../../model-fallback.types.js";
import type { PreparedModelRuntimePluginGeneration } from "../../prepared-model-runtime.types.js";
import type { ReplyDeliveryFactsObserver } from "../../reply-completion.js";
import type { BoundAgentRunSessionTarget } from "../../run-session-target.types.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { CompactionRequestBudget } from "../../sessions/compaction/request-budget.js";
import type { SystemAgentToolOptions } from "../../tools/system-agent-tool.js";
import type { ResolvedRunEntryModelSelection } from "../run-entry.types.js";
import type { DeferredEmbeddedRunLifecycleOwner } from "./deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "./params.js";
import type { EmbeddedRunCompletionCheck } from "./terminal-retry-state.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type CompactionAccountingTarget = Readonly<
  SessionTranscriptRuntimeTarget &
    Pick<InternalSessionEntry, "lifecycleRevision" | "activeWriterRunId">
>;

/** Ordered producer observations; unknown context never borrows an older request's usage. */
export type EmbeddedContextAccountingEvent = Readonly<
  | { kind: "compaction"; tokensAfter: number | undefined }
  | { kind: "request"; contextTokens: number }
  | { kind: "model"; contextTokens: number | undefined; successful: boolean }
>;

/** Writer custody is independent of telemetry; an absent snapshot is not observed unknown context. */
export type CompactionAccountingFact = Readonly<
  { count: number; currentContextSnapshot?: { tokens: number | undefined } } & (
    | {
        kind: "durable";
        target: CompactionAccountingTarget;
        /** Present only when the host committed a successor session rotation. */
        previousSessionId?: string;
        /** Ordered, host-committed identity changes; never inferred from a returned session ID. */
        admissionTransitions?: readonly SessionAdmissionTransition[];
        /** Native-thread compaction leaves the host transcript unchanged. */
        hostCompactionCommitted?: boolean;
      }
    | { kind: "presentation-only" }
  )
>;

export type RunEmbeddedAgentInternalParams = RunEmbeddedAgentParams & {
  /** The reply owner checkpoints the source before recovery rewrites its context. */
  beforeRecoveryCompaction?: (context: {
    sessionId: string;
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource: "auto" | "user";
    contextTokenBudget: number;
  }) => Promise<string>;
  /** A recovery checkpoint must not compact away the history it is trying to save. */
  disableCompactionRecovery?: true;
  /** Original admitted settings, retained by the host across private runtime selection. */
  joinObservation?: ReplyMessageJoinObservation;
  /** The logical run already invoked model routing before preparing its candidate chain. */
  resolvedModelSelection?: ResolvedRunEntryModelSelection;
  preparedTtsPreferences?: PreparedTtsPreferences;
  /** Fail-closed caller input admission against the actual prepared model, before dispatch. */
  assertModelInput?: (model: Pick<Model, "input">) => void;
  /** Keep source-owned custody separate from streamed-block completion in one observation. */
  resolveReplyDeliveryFacts?: ReplyDeliveryFactsObserver;
  /** Reset deferred terminal facts when the host admits a new attempt, before preparation. */
  onAttemptStart?: () => void;
  /** Retire superseded terminal facts only after the host accepts isolated recovery. */
  onAttemptTerminalReplaced?: () => void;
  /** Keep a bounded auxiliary tool set directly visible after runtime admission. */
  disableToolSearch?: true;
  /** Restrict history/search to an explicitly observed session, not this run's store key. */
  sessionReadScopeKey?: string;
  /** Candidate producers have already resolved the model against their captured metadata. */
  requestedRouteResolution?: ModelFallbackRouteResolution;
  onCompactionRequestBudget?: (budget: CompactionRequestBudget | undefined) => void;
  onCompactionAccounting?: (fact: CompactionAccountingFact | undefined) => void;
  /** Attempt-local context observer, installed by the host loop before dispatch. */
  onContextAccountingEvent?: (event: EmbeddedContextAccountingEvent) => void;
  onSuccessfulAuthBinding?: (binding: AgentExecutionAuthBinding) => void;
  /** Maintenance needs the winning profile, not native runtime artifact capture. */
  onSuccessfulAuthProfile?: (profileId: string | undefined) => void;
  authProfileStateMode?: "read-write" | "read-only";
  /** Prepare only the requested candidate with this runtime; fallbacks keep their own policy. */
  agentHarnessRuntimePreparationHint?: string;
  /** Keep staged setup config and credentials outside configured Gateway ownership. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Ring-zero tool override, supplied only by the OpenClaw orchestrator. */
  systemAgentTool?: SystemAgentToolOptions;
  /** Gateway-private lifecycle generation selected before command admission. */
  pluginGeneration?: PreparedModelRuntimePluginGeneration;
  /** Re-admit from the committed transcript without persisting the original prompt again. */
  pluginRuntimeRefreshContinuation?: true;
  pluginRuntimeRefreshUserPrompt?: EmbeddedRunAttemptParams["pluginRuntimeRefreshUserPrompt"];
  pluginRuntimeRefreshMessages?: EmbeddedRunAttemptParams["pluginRuntimeRefreshMessages"];
  /** Actual generation cleanup, including source callbacks after native terminal publication. */
  runCleanupSettlement?: Promise<void>;
  /** Host-only transfer of attempt terminal resources to the logical turn. */
  onDeferredLifecycleOwner?: (owner: DeferredEmbeddedRunLifecycleOwner) => void;
  /** Aborts the logical turn when its retained embedded handle is cancelled. */
  onDeferredLifecycleAbort?: (reason?: "user_abort" | "restart" | "superseded") => void;
  /** Protects an admitted provider wait through the retained logical-turn owner. */
  onRetryWait?: (
    deadlineAtMs: number,
    signal?: AbortSignal,
    wait?: { rateLimitStopMessage?: string },
  ) => ((completed?: boolean) => void) | undefined;
};

export type EmbeddedRunAttemptInternalParams = EmbeddedRunAttemptParams &
  Pick<
    RunEmbeddedAgentInternalParams,
    | "onContextAccountingEvent"
    | "onCompactionRequestBudget"
    | "runCleanupSettlement"
    | "joinObservation"
  > & {
    bindWatchdogAttempt?: (attempt: SessionControllerWatchdogAttempt) => void;
    /** The dispatch owner already selected this target, including any compaction successor. */
    preparedSessionTarget?: {
      readonly target: Readonly<BoundAgentRunSessionTarget & SessionTranscriptTargetBinding>;
      assertCurrent: PreparedSessionSourceAssertion;
    };
    /** Frozen source-attempt model view; transcript writer custody remains unchanged. */
    settledTurnFinalizationMessages?: readonly AgentMessage[];
    compactionCountOwner?: "subscription" | "caller";
    /** Current-run committed plan facts; retained across attempts, never loaded from history. */
    completionCheck?: EmbeddedRunCompletionCheck;
    /** Host-private receiver for the native owner's admitted Gateway-local settings cwd. */
    prepareContinuationRetryCount?: (workspace: { cwd: string }) => void;
  };

export type RunEmbeddedAgentParamsWithSessionFile = RunEmbeddedAgentInternalParams & {
  sessionFile: string;
};
