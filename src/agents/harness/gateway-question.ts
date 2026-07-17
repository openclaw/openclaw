import { randomBytes } from "node:crypto";
import type {
  QuestionRequestQuestion,
  QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  buildAgentHarnessUserInputAnswers,
  type AgentHarnessUserInputAnswers,
  deliverAgentHarnessQuestionPrompt,
  type AgentHarnessUserInputPromptOptions,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const QUESTION_RPC_GRACE_MS = 10_000;
const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

export type AgentHarnessQuestionGatewayCall = (
  method: string,
  opts: { timeoutMs?: number },
  params?: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<unknown>;

type PendingAgentQuestion = {
  questionId: string;
  sessionKey: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  gatewayCall: AgentHarnessQuestionGatewayCall;
  answer?: Promise<QuestionWaitAnswerResult>;
  bufferedAnswers?: AgentHarnessUserInputAnswers;
  cancelRequested: boolean;
  onCancel?: (resolvedBy: string) => void;
  resolving: boolean;
};

const pendingAgentQuestions = new Map<string, PendingAgentQuestion>();

function readQuestionErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const requestError = error as { details?: unknown; name?: unknown };
  if (requestError.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = requestError.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

export function isTerminalAgentQuestionError(error: unknown): boolean {
  const reason = readQuestionErrorReason(error);
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

async function observeCommittedAnswer(
  answer: Promise<QuestionWaitAnswerResult> | undefined,
): Promise<boolean> {
  if (!answer) {
    return false;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      answer,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 1_000);
        timer.unref?.();
      }),
    ]);
    return result?.status === "answered";
  } catch {
    return false;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function resolvePendingAgentQuestionAnswers(
  state: PendingAgentQuestion,
  answers: AgentHarnessUserInputAnswers,
): Promise<boolean> {
  try {
    await state.gatewayCall(
      "question.resolve",
      {},
      { id: state.questionId, answers, resolvedBy: "plain-text" },
    );
    return true;
  } catch (error) {
    if (isTerminalAgentQuestionError(error)) {
      return false;
    }
    // The wait observes a committed resolve even if the resolve response was lost.
    if (await observeCommittedAnswer(state.answer)) {
      return true;
    }
    state.resolving = false;
    throw error;
  }
}

/** Registers one gateway question as the next plain-text claim target for its session. */
export function registerPendingAgentQuestion(params: {
  questionId: string;
  sessionKey: string;
  questions: readonly AgentHarnessUserInputQuestion[];
  gatewayCall: AgentHarnessQuestionGatewayCall;
  answer?: Promise<QuestionWaitAnswerResult>;
  onCancel?: (resolvedBy: string) => void;
}): {
  setAnswer: (answer: Promise<QuestionWaitAnswerResult>) => Promise<boolean>;
  isCancellationRequested: () => boolean;
  isResolving: () => boolean;
  dispose: () => void;
} {
  const sessionKey = params.sessionKey.trim();
  const existing = pendingAgentQuestions.get(sessionKey);
  if (existing) {
    throw new Error(`session already has a pending gateway question: ${existing.questionId}`);
  }
  const state: PendingAgentQuestion = {
    ...params,
    sessionKey,
    cancelRequested: false,
    resolving: false,
  };
  pendingAgentQuestions.set(sessionKey, state);
  return {
    setAnswer: async (answer) => {
      if (pendingAgentQuestions.get(sessionKey) !== state) {
        return false;
      }
      state.answer = answer;
      if (!state.bufferedAnswers) {
        return false;
      }
      const resolved = await resolvePendingAgentQuestionAnswers(state, state.bufferedAnswers);
      if (resolved) {
        delete state.bufferedAnswers;
      }
      return resolved;
    },
    isCancellationRequested: () => state.cancelRequested,
    isResolving: () => state.cancelRequested || state.resolving,
    dispose: () => {
      if (pendingAgentQuestions.get(sessionKey) === state) {
        pendingAgentQuestions.delete(sessionKey);
      }
    },
  };
}

/** Claims the next queued plain-text message for the session's gateway question. */
export async function claimPendingAgentQuestionAnswer(params: {
  sessionKey?: string;
  text: string;
  persist?: () => Promise<void>;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const state = sessionKey ? pendingAgentQuestions.get(sessionKey) : undefined;
  if (!state || state.cancelRequested || state.resolving) {
    return false;
  }
  state.resolving = true;
  try {
    await params.persist?.();
  } catch (error) {
    state.resolving = false;
    throw error;
  }
  const answers = buildAgentHarnessUserInputAnswers(state.questions, params.text);
  if (!state.answer) {
    state.bufferedAnswers = answers;
    return true;
  }
  return await resolvePendingAgentQuestionAnswers(state, answers);
}

/** Cancels a question before the same inbound message takes another route. */
export async function cancelPendingAgentQuestionForSession(params: {
  sessionKey?: string;
  resolvedBy: string;
}): Promise<boolean> {
  const sessionKey = params.sessionKey?.trim();
  const state = sessionKey ? pendingAgentQuestions.get(sessionKey) : undefined;
  if (!state || state.resolving) {
    return false;
  }
  state.cancelRequested = true;
  state.resolving = true;
  try {
    await state.gatewayCall(
      "question.resolve",
      { timeoutMs: QUESTION_RPC_GRACE_MS },
      { id: state.questionId, cancel: true, resolvedBy: params.resolvedBy },
    );
    state.onCancel?.(params.resolvedBy);
    return true;
  } catch (error) {
    if (isTerminalAgentQuestionError(error)) {
      state.onCancel?.(params.resolvedBy);
      return true;
    }
    state.cancelRequested = false;
    state.resolving = false;
    throw error;
  }
}

export type RunAgentHarnessGatewayQuestionParams = {
  questions: readonly AgentHarnessUserInputQuestion[];
  sessionKey: string;
  agentId?: string;
  timeoutMs: number;
  gatewayCall: AgentHarnessQuestionGatewayCall;
  delivery: Pick<EmbeddedRunAttemptParams, "onBlockReply" | "onPartialReply">;
  promptOptions?: AgentHarnessUserInputPromptOptions;
  signal?: AbortSignal;
  questionId?: string;
};

/** Registers, presents, and waits for one harness-owned gateway question record. */
export async function runAgentHarnessGatewayQuestion(
  params: RunAgentHarnessGatewayQuestionParams,
): Promise<QuestionWaitAnswerResult> {
  const questionId = params.questionId ?? `ask_${randomBytes(16).toString("hex")}`;
  const questions: QuestionRequestQuestion[] = params.questions.map((question) => ({
    ...question,
    options: [...(question.options ?? [])],
  }));
  let aborted = false;
  params.signal?.throwIfAborted();
  const claim = registerPendingAgentQuestion({
    questionId,
    sessionKey: params.sessionKey,
    questions: params.questions,
    gatewayCall: params.gatewayCall,
  });
  const cancel = async (resolvedBy: string): Promise<QuestionWaitAnswerResult | undefined> => {
    try {
      return (await params.gatewayCall(
        "question.resolve",
        { timeoutMs: QUESTION_RPC_GRACE_MS },
        { id: questionId, cancel: true, resolvedBy },
      )) as QuestionWaitAnswerResult;
    } catch (error) {
      if (!isTerminalAgentQuestionError(error)) {
        throw error;
      }
      try {
        const result = (await params.gatewayCall(
          "question.waitAnswer",
          { timeoutMs: QUESTION_RPC_GRACE_MS },
          { id: questionId, timeoutMs: 1_000 },
        )) as QuestionWaitAnswerResult;
        return result.status === "answered" ? result : undefined;
      } catch {
        return undefined;
      }
    }
  };
  const onAbort = () => {
    aborted = true;
    // Release the session slot synchronously so a replacement request can register
    // while the best-effort gateway cancellation finishes.
    claim.dispose();
    void cancel("run-abort").catch(() => undefined);
  };

  try {
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      params.signal.throwIfAborted();
    }
    const request = (await params.gatewayCall(
      "question.request",
      {},
      {
        id: questionId,
        questions,
        sessionKey: params.sessionKey,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        timeoutMs: params.timeoutMs,
      },
      params.signal ? { signal: params.signal } : undefined,
    )) as { id?: unknown };
    if (request.id !== questionId) {
      throw new Error("question.request returned an unexpected question id");
    }
    // Cancellation can race registration. Retry against the committed ID and
    // never present a stale prompt after the inbound message took another route.
    if (aborted || claim.isCancellationRequested() || params.signal?.aborted) {
      const terminal = await cancel(
        aborted || params.signal?.aborted ? "run-abort" : "superseded-input",
      );
      if (terminal?.status === "answered") {
        return terminal;
      }
      return { status: "cancelled" };
    }
    const answer = params.gatewayCall(
      "question.waitAnswer",
      { timeoutMs: params.timeoutMs + QUESTION_RPC_GRACE_MS },
      { id: questionId, timeoutMs: params.timeoutMs },
      params.signal ? { signal: params.signal } : undefined,
    ) as Promise<QuestionWaitAnswerResult>;
    const bufferedAnswer = await claim.setAnswer(answer);
    const answerOutcome = answer.then(
      (result) => ({ kind: "answer" as const, result }),
      (error: unknown) => ({ kind: "answer-error" as const, error }),
    );
    const finishAnswer = async (result: QuestionWaitAnswerResult) => {
      if (result.status !== "pending") {
        return result;
      }
      return (await cancel("wait-timeout")) ?? ({ status: "cancelled" } as const);
    };
    if (bufferedAnswer) {
      const terminal = await answerOutcome;
      if (terminal.kind === "answer-error") {
        throw terminal.error;
      }
      return await finishAnswer(terminal.result);
    }
    const beforeDelivery = await Promise.race([
      answerOutcome,
      new Promise<{ kind: "delivery-ready" }>((resolve) => {
        setTimeout(() => resolve({ kind: "delivery-ready" }), 0);
      }),
    ]);
    if (beforeDelivery.kind === "answer") {
      return await finishAnswer(beforeDelivery.result);
    }
    if (beforeDelivery.kind === "answer-error") {
      throw beforeDelivery.error;
    }
    const deliveryAbort = new AbortController();
    const delivery = deliverAgentHarnessQuestionPrompt(
      params.delivery,
      questionId,
      params.questions,
      params.promptOptions,
      deliveryAbort.signal,
    );
    const deliveryOutcome = delivery.then(
      () => ({ kind: "delivery" as const }),
      (error: unknown) => ({ kind: "delivery-error" as const, error }),
    );
    const first = await Promise.race([answerOutcome, deliveryOutcome]);
    if (first.kind === "answer") {
      deliveryAbort.abort(new Error("gateway question resolved before prompt delivery"));
      return await finishAnswer(first.result);
    }
    if (first.kind === "answer-error") {
      deliveryAbort.abort(first.error);
      throw first.error;
    }
    if (first.kind === "delivery-error") {
      const terminal = await cancel("prompt-delivery-failed");
      if (terminal?.status === "answered") {
        return terminal;
      }
      throw new Error("harness question prompt delivery failed", { cause: first.error });
    }
    const terminal = await answerOutcome;
    if (terminal.kind === "answer-error") {
      throw terminal.error;
    }
    return await finishAnswer(terminal.result);
  } catch (error) {
    try {
      const terminal = await cancel(params.signal?.aborted ? "run-abort" : "harness-error");
      if (terminal?.status === "answered") {
        return terminal;
      }
    } catch {
      // Preserve the original bridge failure.
    }
    if (params.signal?.aborted) {
      return { status: "cancelled" };
    }
    throw error;
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
    claim.dispose();
  }
}

export function resetPendingAgentQuestionsForTest(): void {
  pendingAgentQuestions.clear();
}
