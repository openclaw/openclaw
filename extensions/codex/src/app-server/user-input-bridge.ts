import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
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
  questions: UserInputQuestion[];
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
};

type UserInputOption = {
  label: string;
  description: string;
};

const USER_INPUT_PROMPT_MAX_LENGTH = 4096;
const USER_INPUT_TEXT_SCAN_MAX_LENGTH = 4096;
const USER_INPUT_MAX_QUESTIONS = 20;
const USER_INPUT_MAX_OPTIONS_PER_QUESTION = 50;
const USER_INPUT_HEADER_MAX_LENGTH = 80;
const USER_INPUT_QUESTION_MAX_LENGTH = 500;
const USER_INPUT_OPTION_LABEL_MAX_LENGTH = 120;
const USER_INPUT_OPTION_DESCRIPTION_MAX_LENGTH = 200;
const USER_INPUT_PROMPT_OMITTED = "[additional prompt text omitted]";
const ANSI_OSC_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b]|\u009d)[^\u001b\u009c\u0007]*(?:\u0007|\u001b\\|\u009c)`,
  "g",
);
const ANSI_CONTROL_SEQUENCE_RE = new RegExp(
  String.raw`(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_])`,
  "g",
);
const CONTROL_CHARACTER_RE = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]+`, "g");
const INVISIBLE_FORMATTING_CONTROL_RE = new RegExp(
  String.raw`[\u00ad\u034f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`,
  "gu",
);
const DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE = new RegExp(
  String.raw`(?:\u001b\][^\u001b\u009c\u0007]*|\u009d[^\u001b\u009c\u0007]*|\u001b\[[0-?]*[ -/]*|\u009b[0-?]*[ -/]*|\u001b)$`,
);

export type CodexUserInputBridge = {
  handleRequest: (request: {
    id: number | string;
    params?: JsonValue;
  }) => Promise<JsonValue | undefined>;
  handleQueuedMessage: (text: string) => boolean;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
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
        void deliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch((error) => {
          embeddedAgentLog.warn("failed to deliver codex user input prompt", { error });
        });
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
    .slice(0, USER_INPUT_MAX_QUESTIONS)
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
    .slice(0, USER_INPUT_MAX_OPTIONS_PER_QUESTION)
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
): Promise<void> {
  const text = formatUserInputPrompt(questions);
  if (params.onBlockReply) {
    await params.onBlockReply({ text });
    return;
  }
  await params.onPartialReply?.({ text });
}

function formatUserInputPrompt(questions: UserInputQuestion[]): string {
  const lines: string[] = [];
  let promptLength = 0;
  let omitted = false;
  const pushLine = (line: string): boolean => {
    const cost = line.length + (lines.length > 0 ? 1 : 0);
    if (promptLength + cost > USER_INPUT_PROMPT_MAX_LENGTH) {
      omitted = true;
      return false;
    }
    lines.push(line);
    promptLength += cost;
    return true;
  };
  pushLine("Codex needs input:");
  for (const [index, question] of questions.entries()) {
    const header =
      sanitizePromptDisplayText(question.header, USER_INPUT_HEADER_MAX_LENGTH) ??
      `Question ${index + 1}`;
    const prompt =
      sanitizePromptDisplayText(question.question, USER_INPUT_QUESTION_MAX_LENGTH) ??
      "Input requested.";
    if (questions.length > 1) {
      if (!pushLine("") || !pushLine(`${index + 1}. ${header}`) || !pushLine(prompt)) {
        break;
      }
    } else {
      if (!pushLine("") || !pushLine(header) || !pushLine(prompt)) {
        break;
      }
    }
    if (question.isSecret) {
      if (!pushLine("This channel may show your reply to other participants.")) {
        break;
      }
    }
    let exhausted = false;
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      const label =
        sanitizePromptDisplayText(option.label, USER_INPUT_OPTION_LABEL_MAX_LENGTH) ??
        `Option ${optionIndex + 1}`;
      const description = sanitizePromptDisplayText(
        option.description,
        USER_INPUT_OPTION_DESCRIPTION_MAX_LENGTH,
      );
      if (!pushLine(`${optionIndex + 1}. ${label}${description ? ` - ${description}` : ""}`)) {
        exhausted = true;
        break;
      }
    }
    if (exhausted) {
      break;
    }
    if (question.isOther) {
      if (!pushLine("Other: reply with your own answer.")) {
        break;
      }
    }
  }
  return finishPrompt(lines.join("\n"), omitted);
}

function sanitizePromptDisplayText(value: string, maxLength: number): string | undefined {
  const scanned = value.slice(0, USER_INPUT_TEXT_SCAN_MAX_LENGTH);
  const clipped = value.length > USER_INPUT_TEXT_SCAN_MAX_LENGTH;
  const sanitized = scanned
    .replace(ANSI_OSC_SEQUENCE_RE, "")
    .replace(DANGLING_TERMINAL_SEQUENCE_SUFFIX_RE, "")
    .replace(ANSI_CONTROL_SEQUENCE_RE, "")
    .replace(INVISIBLE_FORMATTING_CONTROL_RE, " ")
    .replace(CONTROL_CHARACTER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sanitized) {
    return undefined;
  }
  const truncated = truncateText(sanitized, maxLength);
  return clipped && truncated.length === sanitized.length ? `${truncated}...` : truncated;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function finishPrompt(value: string, omitted: boolean): string {
  if (!omitted && value.length <= USER_INPUT_PROMPT_MAX_LENGTH) {
    return value;
  }
  const suffix = `\n${USER_INPUT_PROMPT_OMITTED}`;
  if (value.endsWith(suffix)) {
    return value;
  }
  if (value.length + suffix.length <= USER_INPUT_PROMPT_MAX_LENGTH) {
    return `${value}${suffix}`;
  }
  return `${value.slice(0, Math.max(0, USER_INPUT_PROMPT_MAX_LENGTH - suffix.length))}${suffix}`;
}

function buildUserInputResponse(questions: UserInputQuestion[], inputText: string): JsonObject {
  const answers: JsonObject = {};
  if (questions.length === 1) {
    const question = questions[0];
    if (question) {
      answers[question.id] = { answers: [normalizeAnswer(inputText, question)] };
    }
    return { answers };
  }

  const keyed = parseKeyedAnswers(inputText);
  const fallbackLines = inputText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  questions.forEach((question, index) => {
    const key =
      keyed.get(question.id.toLowerCase()) ??
      keyed.get(question.header.toLowerCase()) ??
      keyed.get(question.question.toLowerCase()) ??
      keyed.get(String(index + 1));
    const answer = key ?? fallbackLines[index] ?? "";
    answers[question.id] = { answers: answer ? [normalizeAnswer(answer, question)] : [] };
  });
  return { answers };
}

function normalizeAnswer(answer: string, question: UserInputQuestion): string {
  const trimmed = answer.trim();
  const options = question.options ?? [];
  const optionIndex = /^\d+$/.test(trimmed) ? Number(trimmed) - 1 : -1;
  const indexed = optionIndex >= 0 ? options[optionIndex] : undefined;
  if (indexed) {
    return indexed.label;
  }
  const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
  return exact?.label ?? trimmed;
}

function parseKeyedAnswers(inputText: string): Map<string, string> {
  const answers = new Map<string, string>();
  for (const line of inputText.split(/\r?\n/)) {
    const match = line.match(/^\s*([^:=-]+?)\s*[:=-]\s*(.+?)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1]?.trim().toLowerCase();
    const value = match[2]?.trim();
    if (key && value) {
      answers.set(key, value);
    }
  }
  return answers;
}

function emptyUserInputResponse(): JsonObject {
  return { answers: {} };
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const value = record.requestId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
