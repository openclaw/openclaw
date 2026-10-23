import type { SessionConfig } from "@github/copilot-sdk";
import {
  embeddedAgentLog,
  runAgentHarnessGatewayQuestion,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  escapeChatDisplayText as escapeCopilotChatText,
  sanitizeChatDisplayText as sanitizeCopilotDisplayText,
} from "openclaw/plugin-sdk/string-normalization-runtime";

type CopilotUserInputHandler = NonNullable<SessionConfig["onUserInputRequest"]>;
type CopilotUserInputRequest = Parameters<CopilotUserInputHandler>[0];
type CopilotUserInputResponse = Awaited<ReturnType<CopilotUserInputHandler>>;

export type CopilotUserInputBridge = {
  onUserInputRequest: CopilotUserInputHandler;
  cancelPending: () => void;
};

const COPILOT_USER_INPUT_QUESTION_ID = "answer";
const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;

export function createCopilotUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParamsV2;
  signal?: AbortSignal;
  gatewayCall?: Parameters<typeof runAgentHarnessGatewayQuestion>[0]["gatewayCall"];
}): CopilotUserInputBridge {
  let pending: AbortController | undefined;

  return {
    async onUserInputRequest(request) {
      pending?.abort(new Error("Copilot user input request replaced"));
      const abort = new AbortController();
      pending = abort;
      try {
        const question = toQuestion(request);
        const result = await runAgentHarnessGatewayQuestion({
          questions: [question],
          sessionKey: params.paramsForRun.sessionKey ?? params.paramsForRun.sessionId,
          agentId: params.paramsForRun.agentId,
          runId: params.paramsForRun.runId,
          timeoutMs: params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS,
          gatewayCall: params.gatewayCall,
          delivery: params.paramsForRun,
          promptOptions: {
            intro: "Copilot needs input:",
            formatText: formatCopilotDisplayText,
          },
          signal: params.signal ? AbortSignal.any([params.signal, abort.signal]) : abort.signal,
        });
        if (result.status !== "answered") {
          return emptyCopilotUserInputResponse();
        }
        const selected = result.answers.answers[COPILOT_USER_INPUT_QUESTION_ID]?.[0] ?? "";
        return {
          answer: selected,
          wasFreeform: !isChoiceAnswer(question, selected),
        };
      } catch (error) {
        embeddedAgentLog.warn("failed to bridge copilot user input through gateway", { error });
        return emptyCopilotUserInputResponse();
      } finally {
        if (pending === abort) {
          pending = undefined;
        }
      }
    },
    cancelPending() {
      pending?.abort(new Error("Copilot user input request cancelled"));
    },
  };
}

function toQuestion(request: CopilotUserInputRequest): AgentHarnessUserInputQuestion {
  return {
    id: COPILOT_USER_INPUT_QUESTION_ID,
    header: "Copilot",
    question: request.question,
    isOther: request.allowFreeform !== false,
    isSecret: false,
    options:
      request.choices && request.choices.length > 0
        ? request.choices.map((choice: string) => ({ label: choice }))
        : null,
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
