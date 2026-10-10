import type {
  QuestionAnswers,
  QuestionRequestQuestion,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import type { PreparedSessionEntryWorkerRead } from "../../config/sessions/session-entry-read-runtime.types.js";
import { isEmbeddedMode } from "../../infra/embedded-mode.js";
import type { EmbeddedQuestionBroker } from "../../infra/embedded-question-broker.js";
import type { GatewayQuestionCall } from "../tools/gateway-question-lifecycle.js";
import {
  readQuestionDispatchCapability,
  prepareQuestionInputAuthority,
  type QuestionInputAuthority,
} from "./host-private-capabilities.js";
import type {
  AgentHarnessUserInputAnswers,
  AgentHarnessUserInputQuestion,
} from "./user-input-types.js";

export type AgentHarnessQuestionGatewayCall = (
  method: string,
  opts: { timeoutMs?: number },
  params?: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<unknown>;

type QuestionDispatchAuthority =
  | { kind: "unscoped" }
  | {
      kind: "source-bound";
      /** @deprecated Await assertCurrentAsync before the final synchronous assertion. */
      assertCurrent: () => void;
      assertCurrentAsync?: () => Promise<void>;
    };

export class QuestionDispatchRefusedError extends Error {
  override name = "QuestionDispatchRefusedError";
}

export function refuseQuestionDispatch(error: unknown): never {
  throw new QuestionDispatchRefusedError(
    error instanceof Error ? error.message : "question dispatch authority refused",
    { cause: error },
  );
}

export async function prepareQuestionDispatchAuthority(authority: QuestionInputAuthority) {
  try {
    const prepared = await prepareQuestionInputAuthority(authority);
    await prepared.prepareCurrent?.();
    return prepared;
  } catch (error) {
    return refuseQuestionDispatch(error);
  }
}

/** No input was submitted; the inherited name preserves legacy runtime refusal propagation. */
export class QuestionDispatchUnsupportedError extends QuestionDispatchRefusedError {}

/** A core input was refused after question and source preparation. */
export class PreparedQuestionAnswerRefusedError extends Error {
  override name = "PreparedQuestionAnswerRefusedError";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Prepared question input is no longer current", {
      cause,
    });
  }
}

export function buildAgentQuestionRequestQuestions(
  questions: readonly AgentHarnessUserInputQuestion[],
): QuestionRequestQuestion[] {
  return questions.map(({ id, defaultAnswers, ...question }) => ({
    ...question,
    questionId: id,
    options: [...(question.options ?? [])],
    ...(defaultAnswers ? { defaultAnswers: [...defaultAnswers] } : {}),
  }));
}

export function buildAgentQuestionAnswers(parsed: AgentHarnessUserInputAnswers): QuestionAnswers {
  return {
    answers: Object.fromEntries(
      Object.entries(parsed.answers).map(([id, answer]) => [id, answer.answers]),
    ),
  };
}

/** A failed transport cannot release possibly committed input for another route. */
export class QuestionAnswerUnconfirmedError extends Error {
  override name = "QuestionAnswerUnconfirmedError";

  constructor(cause: unknown) {
    super(
      "The question answer may have been accepted, but confirmation was lost. It was not sent again; check the conversation before retrying.",
      { cause },
    );
  }
}

/** Custom transports opt into enforcing authority after preparation, immediately before I/O. */
export type AgentQuestionDispatcher = {
  version: 2;
  call: (request: {
    method: string;
    options: { timeoutMs?: number };
    params?: unknown;
    signal?: AbortSignal;
    authority: QuestionDispatchAuthority;
  }) => Promise<unknown>;
};

/** The effect starts inside the reader's synchronous consumer, before its authority expires. */
export async function withQuestionDispatchAuthority<T>(
  authority: { assertCurrent: () => void } | undefined,
  consume: () => T,
): Promise<T> {
  const capability = readQuestionDispatchCapability(authority?.assertCurrent);
  const callerRead = capability?.callerRead;
  if (!callerRead) {
    (capability?.assertCompatibilityCurrent ?? authority?.assertCurrent)?.();
    return consume();
  }
  const { withSessionEntriesFromStoresInWorker } =
    await import("../../config/sessions/session-entry-read-runtime.js");
  const consumePrepared = (reads: readonly PreparedSessionEntryWorkerRead[]) => {
    callerRead.assertPrepared(reads);
    authority?.assertCurrent();
    return { value: consume() };
  };
  const result = await withSessionEntriesFromStoresInWorker(callerRead.reads, consumePrepared, {
    ordered: true,
  });
  return result.value;
}

export function resolveAgentQuestionGatewayCall(
  dispatcher?: AgentHarnessQuestionGatewayCall | AgentQuestionDispatcher,
): GatewayQuestionCall {
  if (dispatcher && typeof dispatcher !== "function" && dispatcher.version !== 2) {
    throw new Error("unsupported question dispatcher version");
  }
  let embeddedBroker: EmbeddedQuestionBroker | null = null;
  return async (...args) => {
    const [method, options, params, extra] = args;
    if (dispatcher && extra?.dispatchAuthority?.kind === "run") {
      const authority = extra.dispatchAuthority;
      (
        readQuestionDispatchCapability(authority.assertCurrent)?.assertCompatibilityCurrent ??
        authority.assertCurrent
      )();
    }
    if (typeof dispatcher === "function") {
      if (extra?.dispatchAuthority?.kind === "source-bound") {
        extra.dispatchAuthority.assertCurrent();
        throw new QuestionDispatchUnsupportedError(
          "source-bound question input requires the default or a version 2 dispatcher",
        );
      }
      return args.length === 4 && (!extra?.dispatchAuthority || extra.signal)
        ? dispatcher(method, options, params, extra?.signal ? { signal: extra.signal } : undefined)
        : dispatcher(method, options, params);
    }
    if (dispatcher) {
      return dispatcher.call({
        method,
        options,
        params,
        signal: extra?.signal,
        authority:
          extra?.dispatchAuthority?.kind === "source-bound"
            ? {
                kind: "source-bound",
                assertCurrent:
                  readQuestionDispatchCapability(extra.dispatchAuthority.assertCurrent)
                    ?.assertCompatibilityCurrent ?? extra.dispatchAuthority.assertCurrent,
                assertCurrentAsync: extra.dispatchAuthority.prepareCurrent,
              }
            : { kind: "unscoped" },
      });
    }
    if (!embeddedBroker && isEmbeddedMode()) {
      const { getEmbeddedQuestionBroker } = await import("../../infra/embedded-question-broker.js");
      embeddedBroker = getEmbeddedQuestionBroker();
    }
    if (embeddedBroker) {
      // Cancellation/readback stay with the original owner during backend shutdown.
      await extra?.dispatchAuthority?.prepareCurrent?.();
      extra?.signal?.throwIfAborted();
      return withQuestionDispatchAuthority(extra?.dispatchAuthority, () =>
        embeddedBroker!.call(method, params, extra),
      );
    }
    // Keep tool/runtime dependencies out of question registration and SDK imports.
    const { callGatewayTool } = await import("./gateway-question-dispatch.runtime.js");
    return callGatewayTool(method, options, params, extra);
  };
}
