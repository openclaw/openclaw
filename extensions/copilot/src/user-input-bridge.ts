import type { SessionConfig } from "@github/copilot-sdk";
import {
  buildAgentHarnessUserInputAnswers,
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type PendingCopilotUserInput = {
  question: AgentHarnessUserInputQuestion;
  resolve: (value: CopilotUserInputResponse) => void;
  cleanup: () => void;
};

type CopilotUserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type CopilotUserInputRequest = Parameters<CopilotUserInputHandler>[0];
type CopilotUserInputResponse = Awaited<ReturnType<CopilotUserInputHandler>>;

type CopilotUserInputBridge = {
  onUserInputRequest: CopilotUserInputHandler;
  handleQueuedMessage: (text: string) => boolean;
  cancelPending: () => void;
};

const COPILOT_USER_INPUT_QUESTION_ID = "answer";

export function createCopilotUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  signal?: AbortSignal;
}): CopilotUserInputBridge {
  let pending: PendingCopilotUserInput | undefined;

  const resolvePending = (value: CopilotUserInputResponse) => {
    const current = pending;
    if (!current) {
      return;
    }
    pending = undefined;
    current.cleanup();
    current.resolve(value);
  };

  return {
    onUserInputRequest(request) {
      const question = toQuestion(request);
      resolvePending(emptyCopilotUserInputResponse());
      return new Promise<CopilotUserInputResponse>((resolve) => {
        const abortListener = () => resolvePending(emptyCopilotUserInputResponse());
        const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
        pending = { question, resolve, cleanup };
        params.signal?.addEventListener("abort", abortListener, { once: true });
        if (params.signal?.aborted) {
          resolvePending(emptyCopilotUserInputResponse());
          return;
        }
        void deliverAgentHarnessUserInputPrompt(params.paramsForRun, [question], {
          intro: "Copilot needs input:",
          formatText: formatCopilotDisplayText,
        }).catch((error: unknown) => {
          embeddedAgentLog.warn("failed to deliver copilot user input prompt", { error });
        });
      });
    },
    handleQueuedMessage(text) {
      const current = pending;
      if (!current) {
        return false;
      }
      resolvePending(buildCopilotUserInputResponse(current.question, text));
      return true;
    },
    cancelPending() {
      resolvePending(emptyCopilotUserInputResponse());
    },
  };
}

function toQuestion(request: CopilotUserInputRequest): AgentHarnessUserInputQuestion {
  return {
    id: COPILOT_USER_INPUT_QUESTION_ID,
    header: "Copilot needs input",
    question: request.question,
    isOther: request.allowFreeform !== false,
    isSecret: false,
    options:
      request.choices && request.choices.length > 0
        ? request.choices.map((choice: string) => ({ label: choice }))
        : null,
  };
}

function buildCopilotUserInputResponse(
  question: AgentHarnessUserInputQuestion,
  inputText: string,
): CopilotUserInputResponse {
  const rawAnswers = buildAgentHarnessUserInputAnswers([question], inputText);
  const selected = rawAnswers.answers[COPILOT_USER_INPUT_QUESTION_ID]?.answers[0] ?? "";
  return {
    answer: selected,
    wasFreeform: !isChoiceAnswer(question, selected),
  };
}

function emptyCopilotUserInputResponse(): CopilotUserInputResponse {
  return { answer: "", wasFreeform: true };
}

function isChoiceAnswer(question: AgentHarnessUserInputQuestion, answer: string): boolean {
  return Boolean(
    answer &&
    question.options?.some((option) => option.label.toLowerCase() === answer.toLowerCase()),
  );
}

function formatCopilotDisplayText(value: string): string {
  const safe = sanitizeCopilotDisplayText(value).trim();
  return escapeCopilotChatText(safe || "<unknown>");
}

function sanitizeCopilotDisplayText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
  }
  return safe;
}

function escapeCopilotChatText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "\uff20")
    .replaceAll("`", "\uff40")
    .replaceAll("[", "\uff3b")
    .replaceAll("]", "\uff3d")
    .replaceAll("(", "\uff08")
    .replaceAll(")", "\uff09")
    .replaceAll("*", "\u2217")
    .replaceAll("_", "\uff3f")
    .replaceAll("~", "\uff5e")
    .replaceAll("|", "\uff5c");
}

function isUnsafeDisplayCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x001f ||
    (codePoint >= 0x007f && codePoint <= 0x009f) ||
    codePoint === 0x00ad ||
    codePoint === 0x061c ||
    codePoint === 0x180e ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xfff9 && codePoint <= 0xfffb) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f)
  );
}
