import { expect, it, onTestFinished, vi } from "vitest";
import { ReplyDispatchDeliveryError } from "../auto-reply/reply/reply-dispatch-outcome.js";
import { QuestionManager } from "../gateway/question-manager.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createTestContext } from "./embedded-agent-subscribe.handlers.tools.test-support.js";
import type { ToolHandlerContext } from "./embedded-agent-subscribe.handlers.types.js";
import * as questionDispatch from "./harness/gateway-question-dispatch.js";
import {
  beginAskUserPromptDelivery,
  cancelAskUserPromptDelivery,
  createAskUserTool,
  normalizeAskUserParams,
  reserveAskUserPromptDelivery,
} from "./tools/ask-user-tool.js";

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

export function registerAskUserPromptFailureTests(
  startTool: (
    ctx: ToolHandlerContext,
    event: { toolName: "ask_user"; toolCallId: string; args: unknown },
  ) => void | Promise<void>,
) {
  it.each([
    [
      new Error("route declined", {
        cause: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
      }),
      "route declined | socket closed | ECONNRESET",
    ],
    [new ReplyDispatchDeliveryError("failed-before-deliver"), "queued reply delivery failed"],
  ])("logs question delivery diagnostics for %s", async (error, diagnostic) => {
    const { ctx, warn } = createTestContext();
    ctx.params.messageChannel = "telegram";
    ctx.params.currentAccountId = "default";
    ctx.params.onToolResult = async () => {
      throw error;
    };
    const args = createBasicAskUserArgs();
    const toolCallId = "ask-delivery-diagnostics";
    await startTool(ctx, { toolName: "ask_user", toolCallId, args });
    const delivery = beginAskUserPromptDelivery({
      toolCallId,
      sessionKey: ctx.params.sessionKey,
      runId: ctx.params.runId,
      agentId: ctx.params.agentId,
      ...normalizeAskUserParams(args),
    });
    delivery.markReady();
    await expect(delivery.waitForDelivery()).resolves.toEqual({ error });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(diagnostic),
      expect.objectContaining({
        runId: "run-test",
        toolCallId,
        questionId: delivery.questionId,
        channel: "telegram",
        accountId: "default",
        ...(error instanceof ReplyDispatchDeliveryError
          ? { outcome: "failed-before-deliver" }
          : {}),
      }),
    );
    delivery.release();
  });

  it("releases ask_user reservation when the callback flush throws synchronously", () => {
    const { ctx, onBlockReplyFlush } = createTestContext();
    ctx.params.onToolResult = vi.fn();
    const failure = new Error("flush failed");
    onBlockReplyFlush.mockImplementation(() => {
      throw failure;
    });
    const args = createBasicAskUserArgs();

    expect(() =>
      startTool(ctx, { toolName: "ask_user", toolCallId: "ask-callback-failure", args }),
    ).toThrow(failure);
    onTestFinished(() => cancelAskUserPromptDelivery("ask-callback-retry", "agent:unit-session"));
    expect(
      reserveAskUserPromptDelivery({
        toolCallId: "ask-callback-retry",
        sessionKey: "agent:unit-session",
        questions: normalizeAskUserParams(args).questions,
      }),
    ).toBeDefined();
  });
}
