import { expect, vi } from "vitest";
import { createAskUserTool } from "./tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./tools/ask-user-tool.test-support.js";

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
  let resolveAnswer: ((value: { status: "cancelled" }) => void) | undefined;
  const tool = createAskUserTool({
    sessionKey: "agent:unit-session",
    runId: "run-test",
    gatewayCall: async (method, _opts, params) => {
      if (method === "question.request") {
        if (!params || typeof params !== "object" || !("id" in params)) {
          throw new Error("question.request params missing id");
        }
        questionId = String(params.id);
        return { id: questionId };
      }
      if (method === "question.waitAnswer") {
        return await new Promise((resolve) => {
          resolveAnswer = resolve;
        });
      }
      throw new Error(`unexpected method ${method}`);
    },
  });
  const pending = tool.execute(toolCallId, args);
  let finished = false;
  const finish = async () => {
    if (finished) {
      return;
    }
    finished = true;
    await vi.waitFor(() => expect(resolveAnswer).toBeTypeOf("function"));
    resolveAnswer?.({ status: "cancelled" });
    await pending;
    pendingAskUserFinishes.delete(finish);
  };
  pendingAskUserFinishes.add(finish);
  await vi.waitFor(() => expect(questionId).toBeTypeOf("string"));
  return { questionId: questionId!, finish };
}

export async function finishPendingAskUserPrompts() {
  await Promise.all([...pendingAskUserFinishes].map((finish) => finish()));
  resetPendingAskUserQuestionsForTest();
}
