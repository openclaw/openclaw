import { afterEach, describe, expect, it, vi } from "vitest";
import { handleToolExecutionStart } from "./embedded-agent-subscribe.handlers.tools.js";
import { createTestContext } from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import { createAskUserTool } from "./tools/ask-user-tool.js";
import { resetPendingAskUserQuestionsForTest } from "./tools/ask-user-tool.test-support.js";

const sendDurableMessageBatchCore = vi.hoisted(() => vi.fn());

vi.mock("../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore: (...args: unknown[]) => sendDurableMessageBatchCore(...args),
}));

const args = {
  questions: [
    {
      id: "target",
      header: "Target",
      question: "Where next?",
      options: [{ label: "Staging" }, { label: "Production" }],
    },
  ],
  threadId: "1700000000.000200",
};

let resolveAnswer: ((value: { status: "cancelled" }) => void) | undefined;
let pending: Promise<unknown> | undefined;

async function askUser(toolCallId: string) {
  let questionId: string | undefined;
  const tool = createAskUserTool({
    sessionKey: "agent:unit-session",
    runId: "run-test",
    gatewayCall: async (method, _opts, params) => {
      if (method === "question.request") {
        questionId = String((params as { id: unknown }).id);
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
  pending = tool.execute(toolCallId, args);
  await vi.waitFor(() => expect(questionId).toBeTypeOf("string"));
}

afterEach(async () => {
  await vi.waitFor(() => expect(resolveAnswer).toBeTypeOf("function"));
  resolveAnswer?.({ status: "cancelled" });
  await pending;
  resolveAnswer = undefined;
  pending = undefined;
  resetPendingAskUserQuestionsForTest();
  sendDurableMessageBatchCore.mockReset();
});

describe("embedded ask_user threadId", () => {
  it("posts the prompt in the thread the call names", async () => {
    sendDurableMessageBatchCore.mockResolvedValueOnce({ status: "sent", results: [] });
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    ctx.params.config = {};
    ctx.params.messageChannel = "slack";
    ctx.params.currentChannelId = "C1";
    ctx.params.currentThreadId = "1700000000.000100";

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "ask_user",
      toolCallId: "ask-thread",
      args,
    });
    await askUser("ask-thread");
    await vi.waitFor(() => expect(sendDurableMessageBatchCore).toHaveBeenCalledOnce());

    expect(sendDurableMessageBatchCore).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "slack", to: "C1", threadId: "1700000000.000200" }),
    );
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("keeps the run's sender where no channel can take the prompt", async () => {
    const { ctx } = createTestContext();
    const onToolResult = vi.fn();
    ctx.params.onToolResult = onToolResult;
    ctx.params.config = {};
    ctx.params.messageChannel = "webchat";

    await handleToolExecutionStart(ctx, {
      type: "tool_execution_start",
      toolName: "ask_user",
      toolCallId: "ask-thread-webchat",
      args,
    });
    await askUser("ask-thread-webchat");
    await vi.waitFor(() => expect(onToolResult).toHaveBeenCalledOnce());

    expect(sendDurableMessageBatchCore).not.toHaveBeenCalled();
  });
});
