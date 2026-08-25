import type { QuestionWaitAnswerResult } from "../../../packages/gateway-protocol/src/schema/questions.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import {
  runAgentHarnessGatewayQuestion,
  type AgentHarnessQuestionGatewayCall,
} from "./gateway-question.js";
import type {
  StructuredInputAnswerValue,
  StructuredInputCompileResult,
  StructuredInputField,
} from "./structured-input.js";
import {
  deliverAgentHarnessUserInputPrompt,
  type AgentHarnessUserInputPromptOptions,
  type AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

const QUESTION_BATCH_SIZE = 3;
const STATUS_TEXT_LIMIT = 1_024;

export type StructuredInputExecutionResult =
  | {
      status: "answered";
      answers: Record<string, string[]>;
      content: Record<string, StructuredInputAnswerValue>;
    }
  | { status: "declined"; message?: string }
  | { status: "cancelled"; message?: string }
  | { status: "unsupported"; message: string };

type StructuredInputExecutionParams = {
  input: StructuredInputCompileResult;
  sessionKey: string;
  agentId?: string;
  runId?: string;
  timeoutMs: number;
  gatewayCall: AgentHarnessQuestionGatewayCall;
  delivery: Pick<EmbeddedRunAttemptParams, "onBlockReply" | "onPartialReply">;
  signal?: AbortSignal;
  isActive?: () => boolean;
  questionId?: (batch: number) => string | undefined;
  onQuestionPending?: (questionId: string, expiresAtMs: number) => void;
  onQuestionSettled?: (questionId: string) => void;
  promptOptions?: AgentHarnessUserInputPromptOptions & {
    unsupportedIntro?: string;
    urlIntro?: string;
  };
};

/** Executes one compiled form or URL with shared batching, secret, and fencing semantics. */
export async function runStructuredInput(
  params: StructuredInputExecutionParams,
): Promise<StructuredInputExecutionResult> {
  if (params.input.kind === "unsupported") {
    await showStatus(params, params.input.message);
    return { status: "unsupported", message: params.input.message };
  }
  if (!isActive(params)) {
    return { status: "cancelled", message: "Input request is no longer active." };
  }
  return params.input.plan.kind === "url"
    ? runUrl(params, params.input.plan.question)
    : runForm(params, params.input.plan.intro, params.input.plan.fields);
}

async function runUrl(
  params: StructuredInputExecutionParams,
  question: AgentHarnessUserInputQuestion,
): Promise<StructuredInputExecutionResult> {
  const result = await ask(params, [question], 0, params.promptOptions?.urlIntro);
  if (!isActive(params)) {
    return { status: "cancelled", message: "URL confirmation was cancelled before commit." };
  }
  if (result.status !== "answered") {
    const cancellation = cancellationFor(result, "URL confirmation");
    if (cancellation.message) {
      await showStatus(params, cancellation.message);
    }
    return cancellation;
  }
  const answer = result.answers.answers[question.id]?.[0];
  return answer?.toLowerCase() === "continue"
    ? { status: "answered", answers: result.answers.answers, content: {} }
    : { status: "declined" };
}

async function runForm(
  params: StructuredInputExecutionParams,
  intro: string,
  fields: readonly StructuredInputField[],
): Promise<StructuredInputExecutionResult> {
  const answers: Record<string, string[]> = {};
  let index = 0;
  let batch = 0;
  while (index < fields.length) {
    if (!isActive(params)) {
      return { status: "cancelled", message: "Form input was cancelled before completion." };
    }
    const field = fields[index]!;
    if (field.question.isSecret) {
      index += 1;
      const result = await ask(params, [field.question], batch, intro);
      batch += 1;
      if (!isActive(params)) {
        return { status: "cancelled", message: "Secret input was cancelled before commit." };
      }
      if (result.status !== "answered") {
        const cancellation = cancellationFor(result, "Secret input");
        if (cancellation.message) {
          await showStatus(params, cancellation.message);
        }
        return cancellation;
      }
      answers[field.question.id] = result.answers.answers[field.question.id] ?? [];
      continue;
    }
    const ordinary: StructuredInputField[] = [];
    while (
      index < fields.length &&
      ordinary.length < QUESTION_BATCH_SIZE &&
      !fields[index]?.question.isSecret
    ) {
      ordinary.push(fields[index++]!);
    }
    const result = await ask(
      params,
      ordinary.map((entry) => entry.question),
      batch,
      intro,
    );
    batch += 1;
    if (!isActive(params)) {
      return { status: "cancelled", message: "Form input was cancelled before commit." };
    }
    if (result.status !== "answered") {
      const cancellation = cancellationFor(result, "Form input");
      if (cancellation.message) {
        await showStatus(params, cancellation.message);
      }
      return cancellation;
    }
    for (const entry of ordinary) {
      answers[entry.question.id] = result.answers.answers[entry.question.id] ?? [];
    }
  }

  const content: Array<[string, StructuredInputAnswerValue]> = [];
  for (const field of fields) {
    const decoded = field.decode(answers[field.question.id] ?? []);
    if (decoded.kind === "invalid") {
      await showStatus(params, decoded.message);
      return { status: "declined", message: decoded.message };
    }
    if (decoded.kind === "present") {
      content.push(...decoded.entries);
    }
  }
  if (!isActive(params)) {
    return { status: "cancelled", message: "Form input was cancelled before commit." };
  }
  return { status: "answered", answers, content: Object.fromEntries(content) };
}

async function ask(
  params: StructuredInputExecutionParams,
  questions: readonly AgentHarnessUserInputQuestion[],
  batch: number,
  intro: string | undefined,
): Promise<QuestionWaitAnswerResult> {
  const questionId = params.questionId?.(batch);
  if (questionId) {
    params.onQuestionPending?.(questionId, Date.now() + params.timeoutMs + 10_000);
  }
  try {
    return await runAgentHarnessGatewayQuestion({
      questions,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      runId: params.runId,
      timeoutMs: params.timeoutMs,
      gatewayCall: params.gatewayCall,
      delivery: params.delivery,
      promptOptions: {
        ...params.promptOptions,
        ...(intro ? { intro } : {}),
      },
      signal: params.signal,
      questionId,
    });
  } finally {
    if (questionId) {
      params.onQuestionSettled?.(questionId);
    }
  }
}

export type StructuredInputCapability = {
  request: (params: {
    toolCallId: string;
    input: StructuredInputCompileResult;
    timeoutMs: number;
    signal?: AbortSignal;
    promptOptions?: StructuredInputExecutionParams["promptOptions"];
  }) => Promise<StructuredInputExecutionResult>;
  blockingDeadlineMs: () => number | undefined;
  onBlockingDeadlineChange: (listener: () => void) => () => void;
  close: (reason?: string) => void;
};

/** Binds structured input to one exact host run without exposing callable authority to children. */
export function createStructuredInputCapability(
  params: Omit<
    StructuredInputExecutionParams,
    | "input"
    | "timeoutMs"
    | "signal"
    | "questionId"
    | "promptOptions"
    | "onQuestionPending"
    | "onQuestionSettled"
  > & { signal?: AbortSignal },
): StructuredInputCapability {
  const controller = new AbortController();
  const deadlines = new Map<string, number>();
  const deadlineListeners = new Set<() => void>();
  let activeToolCallId: string | undefined;
  let closed = false;
  const isCapabilityActive = () =>
    !closed &&
    !controller.signal.aborted &&
    params.signal?.aborted !== true &&
    (params.isActive?.() ?? true);

  return {
    request: async (request) => {
      const toolCallId = request.toolCallId.trim();
      if (!toolCallId) {
        throw new Error("structured input requires an exact tool call id");
      }
      if (!isCapabilityActive()) {
        return { status: "cancelled", message: "Input request is no longer active." };
      }
      if (activeToolCallId) {
        throw new Error("session already has a pending agent input request");
      }
      activeToolCallId = toolCallId;
      const signal = request.signal
        ? AbortSignal.any([controller.signal, request.signal])
        : controller.signal;
      try {
        const result = await runStructuredInput({
          ...params,
          input: request.input,
          timeoutMs: request.timeoutMs,
          signal,
          promptOptions: request.promptOptions,
          isActive: isCapabilityActive,
          questionId: (batch) => (batch === 0 ? toolCallId : `${toolCallId}:${batch}`),
          onQuestionPending: (questionId, expiresAtMs) => {
            deadlines.set(questionId, expiresAtMs);
            for (const listener of deadlineListeners) {
              listener();
            }
          },
          onQuestionSettled: (questionId) => {
            deadlines.delete(questionId);
            for (const listener of deadlineListeners) {
              listener();
            }
          },
        });
        return isCapabilityActive()
          ? result
          : { status: "cancelled", message: "Input request is no longer active." };
      } finally {
        for (const questionId of deadlines.keys()) {
          if (questionId === toolCallId || questionId.startsWith(`${toolCallId}:`)) {
            deadlines.delete(questionId);
          }
        }
        if (activeToolCallId === toolCallId) {
          activeToolCallId = undefined;
        }
      }
    },
    blockingDeadlineMs: () => {
      let deadline: number | undefined;
      for (const value of deadlines.values()) {
        deadline = Math.max(deadline ?? value, value);
      }
      return deadline;
    },
    onBlockingDeadlineChange: (listener) => {
      deadlineListeners.add(listener);
      return () => deadlineListeners.delete(listener);
    },
    close: (reason = "structured input capability closed") => {
      if (closed) {
        return;
      }
      closed = true;
      deadlines.clear();
      for (const listener of deadlineListeners) {
        listener();
      }
      deadlineListeners.clear();
      controller.abort(new Error(reason));
    },
  };
}

function isActive(params: StructuredInputExecutionParams): boolean {
  return params.signal?.aborted !== true && (params.isActive?.() ?? true);
}

function cancellationFor(
  result: Exclude<QuestionWaitAnswerResult, { status: "answered" }>,
  subject: string,
): { status: "cancelled"; message: string } {
  return {
    status: "cancelled",
    message: result.status === "expired" ? `${subject} expired.` : `${subject} was cancelled.`,
  };
}

async function showStatus(params: StructuredInputExecutionParams, message: string): Promise<void> {
  const question: AgentHarnessUserInputQuestion = {
    id: "unsupported",
    header: "Unsupported",
    question: message.slice(0, STATUS_TEXT_LIMIT),
    isOther: false,
    isSecret: false,
    options: null,
  };
  try {
    await deliverAgentHarnessUserInputPrompt(params.delivery, [question], {
      ...params.promptOptions,
      intro: params.promptOptions?.unsupportedIntro ?? "Input request could not be shown:",
    });
  } catch {
    // The protocol response still reports the closed unsupported/declined outcome.
  }
}
