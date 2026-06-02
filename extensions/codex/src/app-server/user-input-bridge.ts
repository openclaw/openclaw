import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createCodexUserInputPromptControl,
  resolveCodexUserInputControlDelivery,
} from "../conversation-chat-controls.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import {
  buildUserInputResponse,
  emptyUserInputResponse,
  formatUserInputPrompt,
  type UserInputOption,
  type UserInputQuestion,
} from "./user-input-shared.js";

type PendingUserInput = {
  requestId: number | string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  controlToken?: string;
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
};

type CodexUserInputBridge = {
  handleRequest: (request: {
    id: number | string;
    params?: JsonValue;
  }) => Promise<JsonValue | undefined>;
  handleQueuedMessage: (text: string) => CodexQueuedUserInputAnswerResult;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
};

export type CodexQueuedUserInputAnswerResult =
  | {
      handled: true;
      message: string;
    }
  | {
      handled: false;
    };

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
        pending = {
          requestId: request.id,
          threadId: requestParams.threadId,
          turnId: requestParams.turnId,
          itemId: requestParams.itemId,
          questions: requestParams.questions,
          resolve,
          cleanup,
        };
        params.signal?.addEventListener("abort", abortListener, { once: true });
        if (params.signal?.aborted) {
          resolvePending(emptyUserInputResponse());
          return;
        }
        void deliverUserInputPrompt(
          params.paramsForRun,
          requestParams.questions,
          params.threadId,
          (text) => resolvePending(buildUserInputResponse(requestParams.questions, text)),
        )
          .then((token) => {
            if (pending?.requestId === request.id && token) {
              pending.controlToken = token;
            }
          })
          .catch((error) => {
            embeddedAgentLog.warn("failed to deliver codex user input prompt", { error });
          });
      });
    },
    handleQueuedMessage(text) {
      const current = pending;
      if (!current) {
        return { handled: false };
      }
      resolvePending(buildUserInputResponse(current.questions, text));
      if (current.controlToken) {
        resolveCodexUserInputControlDelivery({ token: current.controlToken });
      }
      return { handled: true, message: "Sent answer to Codex." };
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

export function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: UserInputQuestion[];
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
    .filter((question): question is UserInputQuestion => Boolean(question));
  return { threadId, turnId, itemId, questions };
}

function readQuestion(value: JsonValue): UserInputQuestion | undefined {
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

function readOptions(value: JsonValue | undefined): UserInputOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(readOption)
    .filter((option): option is UserInputOption => Boolean(option));
  return options.length > 0 ? options : null;
}

function readOption(value: JsonValue): UserInputOption | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const label = readString(value, "label");
  const description = readString(value, "description") ?? "";
  return label ? { label, description } : undefined;
}

async function deliverUserInputPrompt(
  params: EmbeddedRunAttemptParams,
  questions: UserInputQuestion[],
  threadId: string,
  resolveText: (text: string) => void,
): Promise<string | undefined> {
  if (params.onBlockReply) {
    const { token, payload } = createCodexUserInputPromptControl({
      questions,
      resolveText,
      scope: {
        sessionFile: params.sessionFile,
        threadId,
        channel: params.messageChannel ?? params.messageProvider,
        senderId: params.senderId ?? undefined,
        accountId: params.agentAccountId,
        sessionKey: params.sessionKey,
        messageThreadId: params.messageThreadId ?? params.currentThreadTs,
      },
    });
    await params.onBlockReply(payload);
    return token;
  }
  const text = formatUserInputPrompt(questions);
  await params.onPartialReply?.({ text });
  return undefined;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const value = record.requestId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
