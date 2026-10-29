import { expect, vi } from "vitest";
import { QuestionManager } from "../gateway/question-manager.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import * as questionDispatch from "./harness/gateway-question-dispatch.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";

const pendingAskUserFinishes = new Set<() => Promise<void>>();

export function createBasicAskUserArgs() {
  return {
    questions: [
      {
        id: "target",
        header: "Target",
        question: "Where next?",
        options: [{ label: "Staging" }, { label: "Production" }],
      },
    ],
  };
}

export async function activateAskUserPrompt(toolCallId: string, args: unknown) {
  let questionId: string | undefined;
  const scheduler = createTestGatewayScheduler();
  const questions = new QuestionManager(scheduler);
  const dispatch = questionDispatch.resolveAgentQuestionGatewayCall(
    async (method, _opts, params) => {
      if (method === "question.request") {
        questionId = questions.request(params as Parameters<QuestionManager["request"]>[0]).id;
        return { id: questionId };
      }
      if (method === "question.waitAnswer") {
        return await questions.waitAnswer((params as { id: string }).id);
      }
      if (method === "question.list") {
        return { questions: questions.list() };
      }
      throw new Error(`unexpected method ${method}`);
    },
  );
  const gatewaySpy = vi
    .spyOn(questionDispatch, "resolveAgentQuestionGatewayCall")
    .mockReturnValue(dispatch);
  const tool = createAskUserTool({
    sessionKey: "agent:unit-session",
    runId: "run-test",
  });
  const pending = tool.execute(toolCallId, args);
  let finished = false;
  const finish = async () => {
    if (finished) {
      return;
    }
    finished = true;
    try {
      if (questionId && questions.get(questionId)?.status === "pending") {
        questions.cancel(questionId);
      }
      await pending;
    } finally {
      questions.close();
      try {
        await questions.drain();
        await scheduler.stop();
      } finally {
        gatewaySpy.mockRestore();
        pendingAskUserFinishes.delete(finish);
      }
    }
  };
  pendingAskUserFinishes.add(finish);
  await vi.waitFor(() => expect(questionId).toBeTypeOf("string"));
  return { questionId: questionId!, finish };
}

export async function finishPendingAskUserPrompts() {
  await Promise.all([...pendingAskUserFinishes].map((finish) => finish()));
}
