import type {
  CliBackendUserInputRequest,
  CliBackendUserInputResult,
} from "../../plugins/cli-backend.types.js";
import { assertionSucceeds } from "../../shared/assertion.js";
import { withAgentQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import { runStructuredInput } from "../harness/structured-input-execution.js";
import { compileStructuredInputQuestions } from "../harness/structured-input.js";
import { createCliRunCurrentAssertion } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

function cancelUserInput(message: string): CliBackendUserInputResult {
  return { status: "cancelled", message };
}

export function createPluginUserInputHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingInput: (delta: 1 | -1) => void;
}): (request: CliBackendUserInputRequest) => Promise<CliBackendUserInputResult> {
  const run = params.context.params;
  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = createCliRunCurrentAssertion(run, signal);
    try {
      assertActive();
    } catch {
      return cancelUserInput(
        "OpenClaw cancelled operator input: the admitted run is no longer active.",
      );
    }

    const toolName = request.toolName.trim();
    if (
      !toolName ||
      (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName))
    ) {
      return cancelUserInput(
        toolName
          ? `OpenClaw cancelled operator input from ${toolName}: it is unavailable to this run.`
          : "OpenClaw cancelled an unnamed operator input request.",
      );
    }
    if (request.questions.length === 0 || request.questions.length > 12) {
      return cancelUserInput("OpenClaw cancelled an invalid operator input request.");
    }

    const questionAuthority = params.context.bindQuestionAnswerAuthority?.(assertActive);
    const assertQuestionActive = () => {
      assertActive();
      questionAuthority?.assertActive();
    };
    params.onPendingInput(1);
    try {
      const result = await withAgentQuestionAnswerAuthority(questionAuthority, () =>
        runStructuredInput({
          input: compileStructuredInputQuestions({
            questions: request.questions.map((question) => ({
              ...question,
              isSecret: false,
            })),
            intro: request.intro?.trim() || "Agent needs input:",
          }),
          sessionKey: run.sessionKey ?? run.sessionId,
          agentId: run.agentId,
          runId: run.runId,
          timeoutMs: run.timeoutMs,
          delivery: {
            onBlockReply: run.onBlockReply,
            onPartialReply: run.onPartialReply,
          },
          signal,
          isActive: () => assertionSucceeds(assertQuestionActive),
          questionId: request.toolCallId ? (batch) => `${request.toolCallId}:${batch}` : undefined,
        }),
      );
      try {
        assertQuestionActive();
      } catch {
        return cancelUserInput(
          "OpenClaw cancelled operator input: the admitted run closed before the answer was committed.",
        );
      }
      return result.status === "answered"
        ? { status: "answered", answers: result.answers }
        : cancelUserInput(
            result.message ??
              "OpenClaw cancelled operator input; continue with your best judgment.",
          );
    } catch {
      return cancelUserInput(
        "OpenClaw could not collect operator input; continue with your best judgment.",
      );
    } finally {
      params.onPendingInput(-1);
    }
  };
}
