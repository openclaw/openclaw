/**
 * Bridges Codex item/tool user-input requests to OpenClaw messaging prompts and
 * turns replies into app-server answer payloads.
 */
import {
  buildAgentHarnessUserInputAnswers,
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  emptyAgentHarnessUserInputAnswers,
  registerAgentHarnessQuestion,
  type AgentHarnessQuestionRegistration,
  type AgentHarnessUserInputOption,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

type PendingUserInput = {
  requestId: number | string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AgentHarnessUserInputQuestion[];
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
  // Structured-question lane registration (Control UI card / channel buttons).
  // Cancelled when the legacy free-text reply wins the race, so the rendered
  // question is dismissed everywhere.
  questionRegistration?: AgentHarnessQuestionRegistration;
};

type CodexUserInputBridge = {
  handleRequest: (request: {
    id: number | string;
    params?: JsonValue;
  }) => Promise<JsonValue | undefined>;
  handleQueuedMessage: (text: string) => boolean;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
};

/** Creates a per-turn bridge for pending Codex user-input requests. */
export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): CodexUserInputBridge {
  let pending: PendingUserInput | undefined;

  const resolvePending = (value: JsonValue) => {
    const current = pending;
    if (!current) {
      return;
    }
    pending = undefined;
    current.cleanup();
    // Dismiss the structured-question surfaces. Idempotent: when the structured
    // resolve won the race the manager record is already resolved and this no-ops.
    current.questionRegistration?.cancel("codex-user-input-resolved");
    current.resolve(value);
  };

  return {
    async handleRequest(request) {
      const requestParams = readUserInputParams(request.params);
      if (!requestParams) {
        return undefined;
      }
      if (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) {
        return undefined;
      }
      if (requestParams.questions.length === 0) {
        return emptyUserInputResponse();
      }

      resolvePending(emptyUserInputResponse());

      return new Promise<JsonValue>((resolve) => {
        const abortListener = () => resolvePending(emptyUserInputResponse());
        const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
        const current: PendingUserInput = {
          requestId: request.id,
          threadId: requestParams.threadId,
          turnId: requestParams.turnId,
          itemId: requestParams.itemId,
          questions: requestParams.questions,
          resolve,
          cleanup,
        };
        pending = current;
        params.signal?.addEventListener("abort", abortListener, { once: true });
        if (params.signal?.aborted) {
          resolvePending(emptyUserInputResponse());
          return;
        }
        // Lane-a convergence: also register the question with the global manager so
        // it renders as a Control UI card / channel buttons and can be answered from
        // any surface. Whichever resolves first — a structured question.resolve or
        // the legacy next-free-text reply — wins; resolvePending cancels the other.
        const registration = registerAgentHarnessQuestion({
          questions: requestParams.questions,
          sessionKey: params.paramsForRun.sessionKey ?? null,
        });
        current.questionRegistration = registration;
        void registration.wait
          .then((answers) => {
            if (answers && pending?.questionRegistration === registration) {
              resolvePending(answers as unknown as JsonObject);
            }
          })
          .catch((error: unknown) => {
            embeddedAgentLog.warn("codex structured question resolution failed", { error });
          });
        void deliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch(
          (error: unknown) => {
            embeddedAgentLog.warn("failed to deliver codex user input prompt", { error });
          },
        );
      });
    },
    handleQueuedMessage(text) {
      const current = pending;
      if (!current) {
        return false;
      }
      resolvePending(buildUserInputResponse(current.questions, text));
      return true;
    },
    handleNotification(notification) {
      if (notification.method !== "serverRequest/resolved" || !pending) {
        return;
      }
      const notificationParams = isJsonObject(notification.params)
        ? notification.params
        : undefined;
      const requestId = notificationParams ? readRequestId(notificationParams) : undefined;
      if (
        notificationParams &&
        readString(notificationParams, "threadId") === pending.threadId &&
        requestId !== undefined &&
        String(requestId) === String(pending.requestId)
      ) {
        resolvePending(emptyUserInputResponse());
      }
    },
    cancelPending() {
      resolvePending(emptyUserInputResponse());
    },
  };
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: AgentHarnessUserInputQuestion[];
    }
  | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const itemId = readString(value, "itemId");
  const questionsRaw = value.questions;
  if (!threadId || !turnId || !itemId || !Array.isArray(questionsRaw)) {
    return undefined;
  }
  const questions = questionsRaw
    .map(readQuestion)
    .filter((question): question is AgentHarnessUserInputQuestion => Boolean(question));
  return { threadId, turnId, itemId, questions };
}

function readQuestion(value: JsonValue): AgentHarnessUserInputQuestion | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const id = readString(value, "id");
  const header = readString(value, "header");
  const question = readString(value, "question");
  if (!id || !header || !question) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther: value.isOther === true,
    isSecret: value.isSecret === true,
    options: readOptions(value.options),
  };
}

function readOptions(value: JsonValue | undefined): AgentHarnessUserInputOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(readOption)
    .filter((option): option is AgentHarnessUserInputOption => Boolean(option));
  return options.length > 0 ? options : null;
}

function readOption(value: JsonValue): AgentHarnessUserInputOption | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const label = readString(value, "label");
  const description = readString(value, "description") ?? "";
  return label ? { label, description } : undefined;
}

async function deliverUserInputPrompt(
  params: EmbeddedRunAttemptParams,
  questions: AgentHarnessUserInputQuestion[],
): Promise<void> {
  await deliverAgentHarnessUserInputPrompt(params, questions, {
    formatText: formatCodexDisplayText,
    intro: "Codex needs input:",
  });
}

function buildUserInputResponse(
  questions: AgentHarnessUserInputQuestion[],
  inputText: string,
): JsonObject {
  // Multi-question replies may use "header: answer" or numbered lines. Keep the
  // parser permissive so chat-channel replies remain ergonomic.
  return buildAgentHarnessUserInputAnswers(questions, inputText) as unknown as JsonObject;
}

function emptyUserInputResponse(): JsonObject {
  return emptyAgentHarnessUserInputAnswers() as unknown as JsonObject;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const value = record.requestId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
