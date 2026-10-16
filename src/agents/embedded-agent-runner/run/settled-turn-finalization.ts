import {
  isReplyPayloadTerminalContent,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
  type ReplyPayloadMetadata,
} from "../../../auto-reply/reply-payload.js";
import type { SessionTranscriptWriterFence } from "../../../config/sessions/transcript-write-context.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { classifyAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { runAgentHarnessSettledTurnFinalization } from "../../harness/selection.js";
import type { PreparedSettledTurnFinalizationResult } from "../../harness/settled-turn-finalization-outcome.js";
import type { AgentHarness } from "../../harness/types.js";
import { observeReplyDelivery, resolveReplyExpectation } from "../../reply-completion.js";
import { resolveAgentTimeoutMs } from "../../timeout.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { log } from "../logger.js";
import {
  mergeAttemptRunStatsIntoAccumulator,
  mergeUsageIntoAccumulator,
} from "../usage-accumulator.js";
import { copyAttemptDeliveryState } from "./attempt-delivery-state.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./attempt-result.js";
import { resolveRuntimeModelAttempt } from "./backend.js";
import { shouldTreatEmptyAssistantReplyAsSilent } from "./incomplete-turn-recovery.js";
import type { createEmbeddedRunLaneController } from "./lane-controller.js";
import {
  isEmbeddedRunTerminalTimeout,
  resolveEmbeddedRunAttemptTerminalOutcome,
  type EmbeddedRunTerminalState,
} from "./terminal-outcome.js";
import { prepareEmbeddedRunTerminal } from "./terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./terminal-resolution.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type TerminalPreparationInput = Parameters<typeof prepareEmbeddedRunTerminal>[0];
type CreateAttemptControls = ReturnType<
  typeof createEmbeddedRunLaneController
>["createAttemptControls"];
const MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS = 2;
type TerminalPreparationBase = Omit<
  TerminalPreparationInput,
  | "attempt"
  | "currentAttemptCompletedAssistant"
  | "sessionIdUsed"
  | "sessionFileUsed"
  | "lastRunPromptUsage"
  | "terminalState"
>;

export async function prepareTerminalWithSettledTurnFinalization(input: {
  initial: {
    attempt: EmbeddedRunAttemptWithReceiptEvidence;
    attemptAssistant: EmbeddedRunAttemptWithReceiptEvidence["lastAssistant"];
    currentAttemptCompletedAssistant: EmbeddedRunAttemptWithReceiptEvidence["currentAttemptCompletedAssistant"];
    sessionIdUsed: string;
    sessionFileUsed?: string;
    terminalState: EmbeddedRunTerminalState;
    attemptCompactionCount: number;
  };
  terminalBase: TerminalPreparationBase;
  lastRunPromptUsage: TerminalPreparationInput["lastRunPromptUsage"];
  finalization: {
    preparedAttempt: EmbeddedRunAttemptParams;
    sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
    sessionWriterFence?: SessionTranscriptWriterFence;
    harness: AgentHarness;
    modelApi: string | undefined;
    executionContract: string | undefined;
    hasTerminalToolPresentation: boolean;
    createAttemptControls: CreateAttemptControls;
    abortSignal: AbortSignal;
  };
}) {
  const initial = input.initial;
  const { preparedAttempt, sessionTarget, sessionWriterFence } = input.finalization;
  const committedSessionTarget =
    preparedAttempt.sessionTarget || sessionTarget || sessionWriterFence
      ? { ...preparedAttempt.sessionTarget, ...sessionTarget, ...sessionWriterFence }
      : undefined;
  const sessionWriterDeliveryAuthority = resolveSessionWriterDeliveryAuthority({
    attempt: preparedAttempt,
    sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
    sessionTarget: committedSessionTarget,
  });
  let attempt = initial.attempt;
  let lastRunPromptUsage = input.lastRunPromptUsage;
  const minimumAssistantMessageIndex = (attempt.answerSegments?.at(-1)?.messageEnd ?? -1) + 1;
  const observeSourceDelivery = async () => {
    let sourceReplyDeliveryState: TerminalPreparationInput["sourceReplyDeliveryState"];
    const resolveFacts = input.terminalBase.runParams.resolveReplyDeliveryFacts;
    const replyDeliveryState = await observeReplyDelivery(
      resolveFacts
        ? async (minimum) => {
            const facts = await resolveFacts(minimum);
            sourceReplyDeliveryState = facts.source;
            return facts.terminal;
          }
        : input.terminalBase.runParams.resolveReplyDelivery,
      minimumAssistantMessageIndex,
      (error) =>
        log.warn(
          `reply delivery observation failed; retaining custody: ${formatErrorMessage(error)}`,
        ),
    );
    return {
      replyDeliveryState,
      sourceReplyDeliveryState: sourceReplyDeliveryState ?? replyDeliveryState,
    };
  };
  const delivery = await observeSourceDelivery();
  const { replyDeliveryState } = delivery;
  let prepared = prepareEmbeddedRunTerminal({
    ...input.terminalBase,
    ...initial,
    ...delivery,
    attempt,
    lastRunPromptUsage,
  });
  const preserveInitial = (finalizationOutcome: "not-attempted" | "failed") => ({
    ...initial,
    prepared,
    lastRunPromptUsage,
    finalizationOutcome,
  });
  const prompt = resolveSettledTurnFinalizationRequest({
    runParams: input.terminalBase.runParams,
    attempt,
    activeErrorContext: input.terminalBase.activeErrorContext,
    modelApi: input.finalization.modelApi,
    executionContract: input.finalization.executionContract,
    payloadsWithToolMedia: prepared.payloadsWithToolMedia,
    recoveredFinalAssistantPayloadsAfterPromptTimeout:
      prepared.recoveredFinalAssistantPayloadsAfterPromptTimeout,
    hasTerminalToolPresentation: input.finalization.hasTerminalToolPresentation,
    terminalState: initial.terminalState,
    replyDeliveryState,
    settledTurnFinalizationAvailable:
      !input.terminalBase.runParams.providerReviewAcknowledgment &&
      typeof input.finalization.harness.finalizeSettledTurn === "function",
  });
  if (!prompt) {
    return preserveInitial("not-attempted");
  }
  const assertFinalizationActive = resolveAdmittedRunActiveAssertion(
    input.finalization.preparedAttempt.admittedRunContext,
    input.finalization.abortSignal,
  );
  if (!assertFinalizationActive) {
    throw new Error("admitted run authority is no longer active");
  }
  const runParams = input.terminalBase.runParams;
  const errorContext = input.terminalBase.activeErrorContext;
  const describeRun = () =>
    `runId=${runParams.runId} sessionId=${runParams.sessionId} provider=${errorContext.provider}/${errorContext.model}`;
  // Neither empty recovery nor intentional silence replaces a classified failure or tool error.
  const preserveOriginalTerminal =
    Boolean(initial.attempt.lastToolError) ||
    isEmbeddedRunTerminalTimeout(initial.terminalState.outcome) ||
    classifyAgentRunTerminalOutcome(initial.terminalState.outcome) === "failure";
  log.warn(
    `settled post-tool turn lacked a final answer: ${describeRun()} — running isolated finalization`,
  );
  let finalizationOutcome: "answered" | "empty" | "failed" = "failed";
  try {
    let finalization: Awaited<ReturnType<typeof runPreparedSettledTurnFinalization>>;
    let finalizationAttempt = 0;
    for (;;) {
      finalizationAttempt += 1;
      assertFinalizationActive();
      finalization = await runPreparedSettledTurnFinalization({
        attempt: {
          ...input.finalization.preparedAttempt,
          // The first transcript append may have committed the writer after
          // dispatch preparation. The summary must retain that original fence.
          ...(committedSessionTarget ? { sessionTarget: committedSessionTarget } : {}),
          sessionId: committedSessionTarget?.sessionId ?? initial.sessionIdUsed,
          sessionFile: initial.sessionFileUsed ?? input.finalization.preparedAttempt.sessionFile,
        },
        settledAttempt: initial.attempt,
        harness: input.finalization.harness,
        prompt,
        createAttemptControls: input.finalization.createAttemptControls,
        abortSignal: input.finalization.abortSignal,
      });
      assertFinalizationActive();
      attempt = finalization.attempt;
      mergeUsageIntoAccumulator(input.terminalBase.usageAccumulator, attempt.attemptUsage);
      mergeAttemptRunStatsIntoAccumulator(input.terminalBase.usageAccumulator, attempt);
      lastRunPromptUsage = attempt.attemptUsage ?? lastRunPromptUsage;
      if (
        finalization.outcome === "empty" &&
        shouldTreatEmptyAssistantReplyAsSilent({
          terminalReplyExpectation: resolveReplyExpectation(runParams),
          payloadCount: 0,
          aborted: input.finalization.abortSignal.aborted,
          timedOut: isEmbeddedRunTerminalTimeout(initial.terminalState.outcome),
          attempt,
        })
      ) {
        // Silence ends recovery without replaying work, but is not an authored
        // answer that can clear the original provider cause and recovery guidance.
        if (!preserveOriginalTerminal) {
          finalization.outcome = "answered";
        }
        break;
      }
      if (
        finalization.outcome !== "empty" ||
        finalizationAttempt >= MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS
      ) {
        break;
      }
      log.warn(
        `settled-turn finalization completed without a visible answer: ${describeRun()} — retrying ${finalizationAttempt}/${MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS - 1} with tools disabled`,
      );
    }
    finalizationOutcome = finalization.outcome;
    if (finalization.outcome === "empty") {
      log.warn(
        `settled-turn finalization completed without a visible answer: ${describeRun()} attempts=${finalizationAttempt}/${MAX_EMPTY_SETTLED_FINALIZATION_ATTEMPTS} — preserving failed recovery`,
      );
    }
  } catch (error) {
    if (input.finalization.abortSignal.aborted) {
      log.warn(
        `settled-turn finalization was cancelled: ${describeRun()} error=${formatErrorMessage(error)} — preserving cancellation`,
      );
      return preserveInitial("failed");
    }
    assertFinalizationActive();
    log.warn(
      `settled-turn finalization failed: ${describeRun()} error=${formatErrorMessage(error)} — preserving failed recovery`,
    );
  }
  if (finalizationOutcome !== "answered" && input.finalization.abortSignal.aborted) {
    log.warn(
      `settled-turn finalization was cancelled before terminal delivery: ${describeRun()} — preserving cancellation`,
    );
    return preserveInitial("failed");
  }

  // Only an actual recovery replaces a failed or timed-out turn's terminal ownership.
  const completion =
    finalizationOutcome !== "answered" && preserveOriginalTerminal
      ? initial
      : {
          attempt,
          attemptAssistant: attempt.currentAttemptAssistant,
          currentAttemptCompletedAssistant: attempt.currentAttemptCompletedAssistant,
          terminalState:
            finalizationOutcome !== "answered"
              ? initial.terminalState
              : {
                  outcome: resolveEmbeddedRunAttemptTerminalOutcome({
                    attempt,
                    assistant: attempt.currentAttemptAssistant,
                  }),
                  signalOwnedInterruption: false,
                },
          attemptCompactionCount: 0,
          sessionIdUsed: attempt.sessionIdUsed,
          sessionFileUsed: attempt.sessionFileUsed,
        };
  const finalizedPrepared = prepareEmbeddedRunTerminal({
    ...input.terminalBase,
    ...completion,
    ...(await observeSourceDelivery()),
    lastRunPromptUsage,
  });
  // Only a real finalizer answer may cross source-reply suppression.
  finalizedPrepared.payloadsWithToolMedia?.forEach((payload) => {
    if (finalizationOutcome === "answered") {
      markReplyPayloadForSourceSuppressionDelivery(payload);
    }
    if (sessionWriterDeliveryAuthority) {
      setReplyPayloadMetadata(payload, { sessionWriterDeliveryAuthority });
    }
  });
  // Tool-free finalization cannot resolve failures from the settled tools.
  prepared = {
    ...finalizedPrepared,
    // Recovery can itself commit the source reply (notably WebChat history).
    // Preserve supplements, but never hand an already-owned final to a second sender.
    payloadsWithToolMedia:
      finalizedPrepared.replyDeliveryState === "missing"
        ? finalizedPrepared.payloadsWithToolMedia
        : finalizedPrepared.payloadsWithToolMedia?.filter(
            (payload) => !isReplyPayloadTerminalContent(payload),
          ),
    // A failed recovery has no authored answer for stranded-reply recovery.
    ...(finalizationOutcome !== "answered" &&
    runParams.sourceReplyDeliveryMode === "message_tool_only"
      ? {
          finalAssistantVisibleText: "",
          finalAssistantRawText: "",
          finalAssistantMessageRawText: "",
        }
      : {}),
    attemptToolSummary: prepared.attemptToolSummary,
    failureSignal: prepared.failureSignal,
    terminalToolFailure: prepared.terminalToolFailure,
  };
  return {
    ...completion,
    prepared,
    lastRunPromptUsage,
    finalizationOutcome:
      finalizationOutcome === "answered" ? ("answered" as const) : ("failed" as const),
  };
}

function resolveSessionWriterDeliveryAuthority(input: {
  attempt: EmbeddedRunAttemptParams;
  sessionId: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
}): ReplyPayloadMetadata["sessionWriterDeliveryAuthority"] {
  const target = input.sessionTarget ?? input.attempt.sessionTarget;
  const sessionKey = target?.sessionKey ?? input.attempt.sessionKey;
  const expectedLifecycleRevision = target?.expectedLifecycleRevision;
  const expectedWriterRunId = target?.expectedWriterRunId;
  if (
    !sessionKey ||
    (expectedLifecycleRevision === undefined && expectedWriterRunId === undefined)
  ) {
    return undefined;
  }
  return {
    ...(target?.agentId || input.attempt.agentId
      ? { agentId: target?.agentId ?? input.attempt.agentId }
      : {}),
    expectedSessionId: input.sessionId,
    ...(expectedLifecycleRevision !== undefined ? { expectedLifecycleRevision } : {}),
    ...(expectedWriterRunId !== undefined ? { expectedWriterRunId } : {}),
    sessionKey,
    ...(target?.storePath ? { storePath: target.storePath } : {}),
  };
}

async function runPreparedSettledTurnFinalization(input: {
  attempt: EmbeddedRunAttemptParams;
  settledAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  harness: AgentHarness;
  prompt: string;
  createAttemptControls: CreateAttemptControls;
  abortSignal: AbortSignal;
}): Promise<{ outcome: "answered" | "empty"; attempt: EmbeddedRunAttemptWithReceiptEvidence }> {
  // The original attempt is closed. Each tool-free retry owns its own deadline
  // and Stop callbacks, while queue cancellation remains authoritative throughout.
  const controls = input.createAttemptControls({
    admittedRunContext: input.attempt.admittedRunContext,
    abortSignal: input.abortSignal,
    initialTimeoutMs: resolveAgentTimeoutMs({
      cfg: input.attempt.config,
      overrideMs: input.attempt.timeoutMs,
    }),
  });
  try {
    // The original attempt scope has closed. Rebind this same admitted child,
    // rather than retaining the launching parent's expired tool registration.
    const callerIdentity = createAdmittedGatewayToolCallerIdentity({
      admittedRunContext: input.attempt.admittedRunContext,
      agentId: input.attempt.agentId,
      sessionKey: input.attempt.sessionKey,
    });
    const finalization = await withGatewayToolCallerIdentity(callerIdentity, () =>
      runAgentHarnessSettledTurnFinalization(
        {
          ...input.attempt,
          abortSignal: controls.abortSignal,
          onAttemptDeadlineChanged: controls.onAttemptDeadlineChanged,
          onAttemptTimeout: controls.onAttemptTimeout,
          onAttemptAbort: controls.onAttemptAbort,
          onAttemptTimeoutArmed: undefined,
          operation: "settled-tool-finalization",
          prompt: input.prompt,
          disableTools: true,
          skipPreparedUserTurnMessage: true,
          suppressNextUserMessagePersistence: true,
          initialReplayState: { replayInvalid: false, hadPotentialSideEffects: false },
        },
        input.settledAttempt,
        input.harness,
      ),
    );
    return {
      outcome: finalization.outcome,
      attempt: buildSettledTurnFinalizationAttemptResult({
        result: finalization.result,
        settledAttempt: input.settledAttempt,
        prompt: input.prompt,
        agentHarnessId: input.attempt.agentHarnessId,
        runtimePlan: input.attempt.runtimePlan,
      }),
    };
  } finally {
    controls.close();
  }
}

function buildSettledTurnFinalizationAttemptResult(input: {
  result: PreparedSettledTurnFinalizationResult;
  settledAttempt: EmbeddedRunAttemptWithReceiptEvidence;
  prompt: string;
  agentHarnessId?: string;
  runtimePlan?: EmbeddedRunAttemptParams["runtimePlan"];
}): EmbeddedRunAttemptWithReceiptEvidence {
  const { result, settledAttempt } = input;
  const { preparedTerminalReply } = result;
  const text = preparedTerminalReply.text;
  // Finalization replaces terminal ownership, not host-private facts from settled tools.
  // Its response model does not replace the original runtime-owned selection.
  // Replay, abort, and lifecycle state remain finalizer-local.
  return {
    terminal: { kind: "ok" },
    preparedTerminalReply,
    sessionIdUsed: settledAttempt.sessionIdUsed,
    sessionFileUsed: settledAttempt.sessionFileUsed,
    ...(input.agentHarnessId ? { agentHarnessId: input.agentHarnessId } : {}),
    modelAttempt: resolveRuntimeModelAttempt(input.runtimePlan),
    ...(settledAttempt.runtimeModelSelection
      ? { runtimeModelSelection: settledAttempt.runtimeModelSelection }
      : {}),
    contextTokens: settledAttempt.contextTokens,
    contextTokensSource: settledAttempt.contextTokensSource,
    authBindingFingerprint: settledAttempt.authBindingFingerprint,
    runtimeArtifact: settledAttempt.runtimeArtifact,
    systemPromptReport: settledAttempt.systemPromptReport,
    finalPromptText: input.prompt,
    ...copyAttemptDeliveryState(settledAttempt),
    messagesSnapshot: [...settledAttempt.messagesSnapshot, result.assistant],
    assistantTexts: text ? [text] : [],
    assistantTranscriptOwned: result.assistantTranscriptOwned,
    assistantTranscriptIdempotencyKey: result.assistantTranscriptIdempotencyKey,
    lastAssistantTextMessageIndex: result.assistantMessageIndex,
    lastAssistant: result.assistant,
    currentAttemptAssistant: result.assistant,
    currentAttemptCompletedAssistant: result.assistant,
    toolMetas: settledAttempt.toolMetas,
    lastToolError: settledAttempt.lastToolError,
    successfulNestedToolNames: settledAttempt.successfulNestedToolNames,
    hasToolMediaBlockReply: false,
    cloudCodeAssistFormatError: false,
    attemptUsage: result.usage,
    codeModeEngaged: settledAttempt.codeModeEngaged,
    assistantTurns: 1,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    currentAttemptReplayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    diagnosticTrace: result.diagnosticTrace,
  };
}
