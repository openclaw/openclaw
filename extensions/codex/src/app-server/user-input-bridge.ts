/** Owns per-turn Codex request_user_input and ordinary MCP elicitation lifecycles. */
import {
  agentHarnessStructuredInput as structuredInput,
  embeddedAgentLog,
  emptyAgentHarnessUserInputAnswers,
  type AgentHarnessUserInputOption,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
import type { JsonObject, JsonValue } from "./protocol.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";

const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;
// Codex omits a deadline for nonblocking requests, so bound gateway and secret paths alike.
const NONBLOCKING_USER_INPUT_TIMEOUT_MS = 120_000;
const MAX_USER_INPUT_QUESTIONS = 3;
const MAX_USER_INPUT_OPTIONS = 4;
const MAX_USER_INPUT_ID = 256;
const MAX_USER_INPUT_HEADER = 64;
const MAX_USER_INPUT_TEXT = 4_096;
type StructuredInputCompileResult = ReturnType<typeof structuredInput.compileForm>;

type InteractiveJob = {
  cancelValue: JsonValue;
  failureValue: JsonValue;
  run: (signal: AbortSignal) => Promise<JsonValue | undefined>;
  onResponse?: (value: JsonValue) => void;
};

type CodexInputRequest = { id: number | string; params?: JsonValue };

/** Creates the single per-turn owner for Codex operator input. */
export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
  gatewayCall?: Parameters<typeof structuredInput.run>[0]["gatewayCall"];
  onOrdinaryResponse?: (result: {
    itemId: string;
    questions: readonly AgentHarnessUserInputQuestion[];
    response: JsonValue;
  }) => void;
}) {
  const cleanup = new AbortController();
  const bridgeSignal = params.signal
    ? AbortSignal.any([params.signal, cleanup.signal])
    : cleanup.signal;
  let completion = Promise.resolve();
  const inputSessionKey = params.paramsForRun.sessionKey ?? params.paramsForRun.sessionId;

  const enqueue = (job: InteractiveJob, requestSignal?: AbortSignal) => {
    const signal = requestSignal ? AbortSignal.any([bridgeSignal, requestSignal]) : bridgeSignal;
    if (signal.aborted) {
      return Promise.resolve(job.cancelValue);
    }
    return new Promise<JsonValue>((resolve, reject) => {
      const onAbort = () => resolve(job.cancelValue);
      signal.addEventListener("abort", onAbort, { once: true });
      completion = completion
        .then(async () => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) {
            return;
          }
          let value: JsonValue | undefined;
          try {
            value = await job.run(signal);
          } catch (error) {
            if (!signal.aborted) {
              embeddedAgentLog.warn("failed to bridge codex operator input", { error });
            }
          }
          const response = signal.aborted ? job.cancelValue : (value ?? job.failureValue);
          if (!(signal.reason instanceof CodexServerRequestResolvedError)) {
            job.onResponse?.(response);
          }
          resolve(response);
        })
        .catch(reject);
    });
  };

  const execute = (input: StructuredInputCompileResult, timeoutMs: number, signal: AbortSignal) =>
    structuredInput.run({
      input,
      sessionKey: inputSessionKey,
      agentId: params.paramsForRun.agentId,
      runId: params.paramsForRun.runId,
      timeoutMs,
      gatewayCall: params.gatewayCall,
      delivery: params.paramsForRun,
      signal,
      promptOptions: {
        formatText: formatCodexDisplayText,
        unsupportedIntro: "Codex input request could not be shown:",
        urlIntro: "Codex needs confirmation:",
      },
    });

  return {
    async handleRequest(request: CodexInputRequest, requestSignal?: AbortSignal) {
      const requestParams = readUserInputParams(request.params);
      if (
        !requestParams ||
        requestParams.threadId !== params.threadId ||
        requestParams.turnId !== params.turnId
      ) {
        return undefined;
      }
      if (requestParams.questions.length === 0) {
        return emptyUserInputResponse();
      }
      const timeoutMs = requestParams.isBlocking
        ? (params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS)
        : NONBLOCKING_USER_INPUT_TIMEOUT_MS;
      const input = compileUserInputQuestions(requestParams.questions);
      const cancelValue = emptyUserInputResponse();
      return await enqueue(
        {
          cancelValue,
          failureValue: cancelValue,
          // Secret requests never enter the transcript, including cancelled or mixed forms.
          onResponse: requestParams.questions.some((question) => question.isSecret)
            ? undefined
            : (response) =>
                params.onOrdinaryResponse?.({
                  itemId: requestParams.itemId,
                  questions: requestParams.questions,
                  response,
                }),
          run: async (signal) => {
            const result = await execute(input, timeoutMs, signal);
            return result.status === "answered"
              ? gatewayAnswersToCodexResponse(result.answers)
              : cancelValue;
          },
        },
        requestSignal,
      );
    },
    async handleElicitationRequest(request: CodexInputRequest, requestSignal?: AbortSignal) {
      if (readOwnDataString(request.params, "threadId") !== params.threadId) {
        return undefined;
      }
      const requestSnapshot = structuredInput.snapshot(request.params);
      if (
        structuredInput.isRecord(requestSnapshot) &&
        readOwnDataString(requestSnapshot, "threadId") !== params.threadId
      ) {
        return undefined;
      }
      const { compileCodexOrdinaryElicitation } = await import("./elicitation-input.js");
      const compiled = structuredInput.isRecord(requestSnapshot)
        ? compileCodexOrdinaryElicitation({ snapshot: requestSnapshot, turnId: params.turnId })
        : {
            kind: "compiled" as const,
            input: {
              kind: "unsupported" as const,
              message: "OpenClaw declined a malformed or over-limit MCP elicitation request.",
            },
          };
      if (compiled.kind === "ignored") {
        return undefined;
      }
      const cancelValue = createCodexElicitationResponse("cancel");
      const timeoutMs = params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS;
      return await enqueue(
        {
          cancelValue,
          failureValue: declineElicitation("OpenClaw could not handle this elicitation."),
          run: async (signal) => {
            const result = await execute(compiled.input, timeoutMs, signal);
            if (result.status === "answered") {
              const content =
                compiled.input.kind === "ready" && compiled.input.plan.kind === "url"
                  ? null
                  : result.content;
              return createCodexElicitationResponse("accept", content);
            }
            if (result.status === "declined" || result.status === "unsupported") {
              return declineElicitation(result.message);
            }
            return cancelValue;
          },
        },
        requestSignal,
      );
    },
    async cancelPending() {
      cleanup.abort(new Error("Codex operator input request cancelled"));
      await completion;
    },
  };
}

function compileUserInputQuestions(
  questions: readonly AgentHarnessUserInputQuestion[],
): StructuredInputCompileResult {
  return structuredInput.compileQuestions({ questions, intro: "Codex needs input:" });
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: AgentHarnessUserInputQuestion[];
      isBlocking: boolean;
    }
  | undefined {
  const snapshot = structuredInput.snapshot(value);
  if (!structuredInput.isRecord(snapshot)) {
    return undefined;
  }
  const threadId = readBoundedUserInputText(snapshot, "threadId", MAX_USER_INPUT_ID);
  const turnId = readBoundedUserInputText(snapshot, "turnId", MAX_USER_INPUT_ID);
  const itemId = readBoundedUserInputText(snapshot, "itemId", MAX_USER_INPUT_ID);
  const questions = readArray(snapshot, "questions", MAX_USER_INPUT_QUESTIONS);
  if (!threadId || !turnId || !itemId || !questions) {
    return undefined;
  }
  const parsed: AgentHarnessUserInputQuestion[] = [];
  for (const questionValue of questions) {
    const question = readQuestion(questionValue);
    if (!question) {
      return undefined;
    }
    parsed.push(question);
  }
  return {
    threadId,
    turnId,
    itemId,
    questions: parsed,
    isBlocking: readValue(snapshot, "isBlocking") !== false,
  };
}

function readQuestion(value: unknown): AgentHarnessUserInputQuestion | undefined {
  if (!structuredInput.isRecord(value)) {
    return undefined;
  }
  const id = readBoundedUserInputText(value, "id", MAX_USER_INPUT_ID);
  const header = readBoundedUserInputText(value, "header", MAX_USER_INPUT_HEADER);
  const question = readBoundedUserInputText(value, "question", MAX_USER_INPUT_TEXT);
  if (!id || !header || !question) {
    return undefined;
  }
  const options = readOptions(readValue(value, "options"));
  if (options === undefined) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther: readValue(value, "isOther") === true,
    isSecret: readValue(value, "isSecret") === true,
    ...(readValue(value, "multiSelect") === true ? { multiSelect: true } : {}),
    options,
  };
}

function readOptions(value: unknown): AgentHarnessUserInputOption[] | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_USER_INPUT_OPTIONS) {
    return undefined;
  }
  const options: AgentHarnessUserInputOption[] = [];
  for (const entry of value) {
    if (!structuredInput.isRecord(entry)) {
      return undefined;
    }
    const label = readBoundedUserInputText(entry, "label", MAX_USER_INPUT_ID);
    const description = readBoundedUserInputText(entry, "description", MAX_USER_INPUT_TEXT, true);
    if (!label) {
      return undefined;
    }
    options.push({ label, ...(description ? { description } : {}) });
  }
  return options;
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readBoundedUserInputText(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0)
    ? value
    : undefined;
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): unknown[] | undefined {
  const value = readValue(record, key);
  return Array.isArray(value) && value.length <= maximum ? value : undefined;
}

function readOwnDataString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function gatewayAnswersToCodexResponse(answers: Record<string, string[]>): JsonObject {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    ),
  };
}

function emptyUserInputResponse(): JsonObject {
  return { ...emptyAgentHarnessUserInputAnswers() };
}

function declineElicitation(message?: string) {
  return createCodexElicitationResponse("decline", null, message ? { message } : null);
}
