import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  runWithSessionSourceScope,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { ImageContent } from "../../../llm/types.js";
import type { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { Agent, AgentMessage } from "../../runtime/index.js";
import type { NextUserMessagePersistence } from "../../session-tool-result-guard.js";
import { buildSessionsYieldContextMessage } from "../../sessions-yield-context.js";
import { agentSessionQueuePromptContext } from "../../sessions/agent-session-prompting.js";
import {
  attachPromptCompactionRequestBudget,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import type { AgentSession } from "../../sessions/index.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import {
  declarePromptHistoryRewrite,
  recordAggregateTruncation,
} from "../prompt-cache-observability.js";
import type { MeasuredRequestContext } from "../prompt-cache-request-observer.js";
import type { ActiveEmbeddedRunAttachment } from "../run-state.js";
import { updateActiveEmbeddedRunSnapshot } from "../runs.js";
import type { ToolResultPromptProjectionState } from "../session-prompt-state.js";
import { truncateOversizedToolResultsInMessages } from "../tool-result-truncation.js";
import { snapshotRecentMessages } from "./attempt-context-summary.js";
import {
  installModelPromptProjection,
  installRuntimeContextMessageForPrompt,
  resolveModelPromptText,
} from "./attempt-llm-boundary.js";
import type { UserTranscriptContext } from "./attempt-llm-boundary.types.js";
import {
  isSessionsYieldAbortError,
  stripSessionsYieldArtifacts,
} from "./attempt-sessions-yield.js";
import { waitForEmbeddedAbortSettle } from "./attempt-subscription-cleanup.js";
import type { createChatGPTV2CompactionBoundary } from "./chatgpt-v2-compaction.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import { isMidTurnPrecheckSignal, type MidTurnPrecheckRequest } from "./midturn-precheck.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type PromptSubmissionSession = {
  messages: AgentMessage[];
  readonly isCompacting: boolean;
  [agentSessionQueuePromptContext]: AgentSession[typeof agentSessionQueuePromptContext];
  agent: {
    state: { messages: AgentMessage[] };
    streamFn: StreamFn;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    prepareNextTurn?: Agent["prepareNextTurn"];
    prepareNextTurnWithContext?: Agent["prepareNextTurnWithContext"];
    continue?: () => Promise<void>;
  };
};

type PromptActiveSession = (
  prompt: string,
  options?: Parameters<AgentSession["prompt"]>[1],
) => Promise<void>;

type TrajectoryRecorder = Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>;

export async function submitEmbeddedAttemptPrompt(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    | "promptCacheKey"
    | "sessionId"
    | "sessionKey"
    | "skipPreparedUserTurnMessage"
    | "userTurnTranscriptRecorder"
  >;
  registration?: ActiveEmbeddedRunAttachment;
  activeSession: PromptSubmissionSession;
  appendOnlyRuntimeContext?: boolean;
  appendContext?: string;
  contextTokenBudget: number;
  compactionRequestBudget?: CompactionRequestBudget;
  compactBeforeRequest?: ReturnType<typeof createChatGPTV2CompactionBoundary>;
  images: ImageContent[];
  modelPrompt: string;
  onFinalPromptText: (prompt: string) => void;
  assertHostActive?: SessionSourceAssertion;
  getUserTranscriptContexts?: () => readonly UserTranscriptContext[] | undefined;
  withTranscriptWrite?: <T>(write: () => Promise<T>) => Promise<T>;
  onModelRequest?: (
    model: Parameters<StreamFn>[0],
    context: Parameters<StreamFn>[1],
    signal?: AbortSignal,
  ) => MeasuredRequestContext | undefined | Promise<MeasuredRequestContext | undefined>;
  persistToolResultProjections: () => Promise<void>;
  prependContext?: string;
  promptActiveSession: PromptActiveSession;
  runtimeContextMessage?: RuntimeContextCustomMessage;
  runtimeOnly: boolean;
  setNextUserMessagePersistence?: (mode: NextUserMessagePersistence) => void;
  systemPrompt: string;
  toolResultAggregateMaxChars: number;
  toolResultMaxChars: number;
  toolResultPromptProjectionState: ToolResultPromptProjectionState;
  trajectoryRecorder: TrajectoryRecorder | null;
  transcriptLeafId: string | null;
  transcriptPrompt: string;
}): Promise<void> {
  const { activeSession, attempt } = input;
  const userTurnRecorder = attempt.userTurnTranscriptRecorder;
  const projectionRecorder =
    attempt.skipPreparedUserTurnMessage || input.runtimeOnly || userTurnRecorder?.isBlocked()
      ? undefined
      : userTurnRecorder;
  const persistedUserIdempotencyKey =
    attempt.skipPreparedUserTurnMessage !== true && userTurnRecorder?.hasPersisted() === true
      ? (userTurnRecorder.getPersistedMessage?.() ?? userTurnRecorder.message)?.idempotencyKey
      : undefined;

  const installProviderPromptHistoryTransform = (): (() => void) => {
    const baseStreamFn = activeSession.agent.streamFn;
    const basePrepareNextTurn = activeSession.agent.prepareNextTurnWithContext;
    const lateUpdates: AgentMessage[] = [];
    const prepareNextTurn: NonNullable<Agent["prepareNextTurnWithContext"]> = async (
      turn,
      signal,
    ) => {
      const snapshot = basePrepareNextTurn
        ? await basePrepareNextTurn.call(activeSession.agent, turn, signal)
        : await activeSession.agent.prepareNextTurn?.(signal);
      if (lateUpdates.length === 0) {
        return snapshot;
      }
      const updates = lateUpdates.splice(0);
      const context = snapshot?.context ?? turn.context;
      // Dispatch saw the update after conversion; insert it before the answer it governed.
      const index = context.messages.indexOf(turn.message);
      if (index < 0) {
        return snapshot;
      }
      const newMessageIndex = turn.newMessages.indexOf(turn.message);
      if (newMessageIndex >= 0) {
        turn.newMessages.splice(
          newMessageIndex,
          0,
          ...updates.filter((update) => !turn.newMessages.includes(update)),
        );
      }
      const missing = updates.filter((update) => !context.messages.includes(update));
      return {
        ...snapshot,
        context: {
          ...context,
          messages: [
            ...context.messages.slice(0, index),
            ...missing,
            ...context.messages.slice(index),
          ],
        },
      };
    };
    activeSession.agent.prepareNextTurnWithContext = prepareNextTurn;
    const persistThenStream: StreamFn = async (model, context, options) =>
      runWithSessionSourceScope(
        input.assertHostActive,
        async () => {
          const assertRequestCurrent = () => {
            options?.signal?.throwIfAborted();
            (input.assertHostActive?.assertScopeCurrent ?? input.assertHostActive)?.();
          };
          // Runtime admission queues behind the user append; join it outside that write lane.
          await userTurnRecorder?.waitForRuntimePersistence();
          assertRequestCurrent();
          await input.persistToolResultProjections();
          assertRequestCurrent();
          let requestContext = context;
          const foregroundRequest = captureCurrentPromptForModel && !activeSession.isCompacting;
          // Observe before V2 decides: only this observation can anchor the request's
          // measured prefix. A checkpoint request is observed again as its own request.
          const requestAnchor = foregroundRequest
            ? await input.onModelRequest?.(model, requestContext, options?.signal)
            : undefined;
          assertRequestCurrent();
          if (foregroundRequest && input.compactBeforeRequest) {
            const checkpoint = await input.compactBeforeRequest(
              async (compactionModel, compactionContext, compactionOptions) => {
                await input.onModelRequest?.(
                  compactionModel,
                  compactionContext,
                  compactionOptions?.signal,
                );
                assertRequestCurrent();
                return baseStreamFn(compactionModel, compactionContext, compactionOptions);
              },
              model,
              requestContext,
              options,
              requestAnchor,
            );
            assertRequestCurrent();
            if (checkpoint) {
              // The provider checkpoint owns this entire outgoing prefix. Keep its
              // carrier in the loop as well as the durable session before the answer.
              lateUpdates.push(checkpoint);
              requestContext = {
                ...requestContext,
                messages: [...requestContext.messages, checkpoint],
              };
              await input.onModelRequest?.(model, requestContext, options?.signal);
            }
          }
          assertRequestCurrent();
          input.assertHostActive?.();
          if (foregroundRequest) {
            projectionRecorder?.markSentToProvider?.();
          }
          const stream = await baseStreamFn(model, requestContext, options);
          return stream;
        },
        { checkAfter: false },
      );
    const providerPromptStreamFn = wrapStreamFnWithMessageTransform(
      persistThenStream,
      (messages) => {
        const providerPromptHistoryTruncation = truncateOversizedToolResultsInMessages(
          messages,
          input.contextTokenBudget,
          input.toolResultMaxChars,
          input.toolResultAggregateMaxChars,
          input.toolResultPromptProjectionState,
        );
        const providerMessages = providerPromptHistoryTruncation.messages;
        if (providerPromptHistoryTruncation.truncatedCount > 0) {
          declarePromptHistoryRewrite({ ...attempt, reason: "pruning" });
        }
        if (providerPromptHistoryTruncation.aggregateTruncatedCount > 0) {
          recordAggregateTruncation(attempt);
        }
        return providerMessages;
      },
    );
    activeSession.agent.streamFn = providerPromptStreamFn;
    return () => {
      if (activeSession.agent.prepareNextTurnWithContext === prepareNextTurn) {
        activeSession.agent.prepareNextTurnWithContext = basePrepareNextTurn;
      }
      if (activeSession.agent.streamFn === providerPromptStreamFn) {
        activeSession.agent.streamFn = baseStreamFn;
      }
    };
  };

  input.onFinalPromptText(input.transcriptPrompt);
  input.trajectoryRecorder?.recordEvent("prompt.submitted", {
    prompt: input.modelPrompt,
    systemPrompt: input.systemPrompt,
    messages: activeSession.messages,
    imagesCount: input.images.length,
  });
  updateActiveEmbeddedRunSnapshot(input.registration, {
    transcriptLeafId: input.transcriptLeafId,
    messages: snapshotRecentMessages(activeSession.messages),
    inFlightPrompt: input.transcriptPrompt,
  });

  // An internal prompt has no transcript recorder to capture a model-facing projection,
  // so it is submitted and persisted as the exact text the model receives.
  const internalPrompt = attempt.skipPreparedUserTurnMessage === true;
  const submittedPrompt = internalPrompt
    ? resolveModelPromptText({ ...input, text: input.transcriptPrompt })
    : input.transcriptPrompt;
  let captureCurrentPromptForModel = false;
  const cleanupModelPromptTransform = internalPrompt
    ? () => {}
    : installModelPromptProjection({
        session: activeSession,
        carrier: input.appendOnlyRuntimeContext ? input.runtimeContextMessage : undefined,
        transcriptPrompt: input.transcriptPrompt,
        modelPrompt: input.modelPrompt,
        prependContext: input.prependContext,
        appendContext: input.appendContext,
        shouldCapturePrompt: () => captureCurrentPromptForModel,
        recorder: projectionRecorder,
        withTranscriptWrite: input.withTranscriptWrite,
        getUserTranscriptContexts: input.getUserTranscriptContexts,
        assertCurrent: input.assertHostActive,
      });
  const armModelPromptTransform = (submitted: boolean) => {
    captureCurrentPromptForModel ||= submitted;
  };
  const promptOptions = {
    ...(!input.runtimeOnly && input.images.length > 0 ? { images: input.images } : {}),
    ...(persistedUserIdempotencyKey ? { persistedUserIdempotencyKey } : {}),
    preflightResult: armModelPromptTransform,
  };
  attachPromptCompactionRequestBudget(promptOptions, input.compactionRequestBudget);
  const cleanupProviderPromptHistoryTransform = installProviderPromptHistoryTransform();
  // Retain the model prefix without attributing a synthetic or internal prompt to a human;
  // suppressing it would orphan the runtime context persisted after it.
  const modelOnlyPrompt = input.runtimeOnly || internalPrompt;
  if (modelOnlyPrompt) {
    input.setNextUserMessagePersistence?.("runtime");
  }
  try {
    // Persist after the user (or synthetic runtime prompt), retiring unconsumed
    // context when preflight handles or rejects the prompt before the loop starts.
    const cleanupRuntimeContextMessage =
      input.appendOnlyRuntimeContext && input.runtimeContextMessage
        ? activeSession[agentSessionQueuePromptContext](input.runtimeContextMessage)
        : installRuntimeContextMessageForPrompt({
            session: activeSession,
            message: input.runtimeContextMessage,
            persistedUserIdempotencyKey,
          });
    try {
      await input.promptActiveSession(submittedPrompt, promptOptions);
    } finally {
      cleanupRuntimeContextMessage();
    }
  } finally {
    if (modelOnlyPrompt) {
      // Preflight can fail before consuming the one-shot persistence mode.
      input.setNextUserMessagePersistence?.("normal");
    }
    cleanupProviderPromptHistoryTransform();
    cleanupModelPromptTransform();
  }
}

type PromptSubmissionSkipReason = "blank_user_prompt" | "empty_prompt_history_images";

/** Classifies prompt submissions that have no visible current-turn content. */
export function resolvePromptSubmissionSkipReason(params: {
  prompt: string;
  messages: readonly unknown[];
  imageCount: number;
}): PromptSubmissionSkipReason | null {
  if (params.prompt.trim().length > 0 || params.imageCount > 0) {
    return null;
  }
  return params.messages.some(hasVisiblePromptHistory)
    ? "blank_user_prompt"
    : "empty_prompt_history_images";
}

function hasVisiblePromptHistory(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") {
    return false;
  }
  return hasNonEmptyContent(record.content);
}

function hasNonEmptyContent(content: unknown): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(hasNonEmptyContent);
  }
  if (!content || typeof content !== "object") {
    return false;
  }
  const record = content as { text?: unknown; content?: unknown };
  return hasNonEmptyContent(record.text) || hasNonEmptyContent(record.content);
}

/** Classifies prompt failures and performs yield or mid-turn recovery. */
type PromptErrorAttempt = Pick<EmbeddedRunAttemptParams, "runId" | "sessionId" | "abortSignal">;
type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

type EmbeddedAttemptPromptErrorOutcome = {
  promptFailure?: {
    error: unknown;
    source: "prompt";
  };
};

export async function handleEmbeddedAttemptPromptError(input: {
  activeSession: AgentSession;
  attempt: PromptErrorAttempt;
  error: unknown;
  handleMidTurnPrecheckRequest: (request: MidTurnPrecheckRequest) => Promise<void>;
  markYieldAborted: () => void;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
}): Promise<EmbeddedAttemptPromptErrorOutcome> {
  const yieldAborted = input.yieldDetected && isSessionsYieldAbortError(input.error);
  if (yieldAborted) {
    // Publish terminal state before fallible recovery so outer cleanup still recognizes the yield.
    input.markYieldAborted();
  }
  if (yieldAborted) {
    await waitForEmbeddedAbortSettle({
      promise: input.yieldAbortSettled,
      runId: input.attempt.runId,
      sessionId: input.attempt.sessionId,
      reason: "sessions_yield",
    });
    await input.withOwnedTranscriptWrite(async () => {
      const transcriptRewritten = await withSessionManagerWrite(
        input.activeSession.sessionManager,
        () => stripSessionsYieldArtifacts(input.activeSession),
      );
      if (input.yieldMessage) {
        await input.activeSession.sendCustomMessage(
          buildSessionsYieldContextMessage(input.yieldMessage),
          { triggerTurn: false },
        );
      }
      const target = transcriptRewritten && input.activeSession.sessionManager.getSessionTarget();
      if (target) {
        // Yield cleanup owns this rewrite; settle its projection before handing off the lane.
        // The caller signal stays live during a deliberate sessions_yield provider abort.
        const { waitForSessionTranscriptProjection } =
          await import("../../../config/sessions/session-transcript-reconcile.js");
        await waitForSessionTranscriptProjection(target, input.attempt.abortSignal);
      }
    });
    return {};
  }

  if (isMidTurnPrecheckSignal(input.error)) {
    const request = input.error.request;
    await input.withOwnedTranscriptWrite(() =>
      withSessionManagerWrite(input.activeSession.sessionManager, () =>
        input.handleMidTurnPrecheckRequest(request),
      ),
    );
    return {};
  }

  return {
    promptFailure: {
      error: input.error,
      source: "prompt",
    },
  };
}
