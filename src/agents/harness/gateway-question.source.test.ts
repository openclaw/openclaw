import { expect, it, vi } from "vitest";
import type { SourceQuestionV1 } from "../../auto-reply/source-question.types.js";
import {
  createAskUserTool,
  reserveAskUserPromptDelivery,
  waitForAskUserPromptReady,
} from "../tools/ask-user-tool.js";
import { runAgentHarnessGatewayQuestion } from "./gateway-question.js";
import { withQuestionGateway } from "./gateway-question.test-support.js";
import {
  createAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "./host-private-capabilities.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";
const sessionKey = "agent:main:source-question";
const questions = [
  { id: "seats", header: "Seats", question: "How many seats?", options: [], isOther: true },
] as const;

it.each([false, true])(
  "publishes a registered question through its source owner (receiver fails: %s)",
  async (rejectPublication) => {
    await withQuestionGateway(async (fixture) => {
      const source = new AbortController();
      let captured: SourceQuestionV1 | undefined;
      const onQuestion = vi.fn(async (question: SourceQuestionV1) => {
        captured = question;
        expect(fixture.manager.get(questionId)?.status).toBe("pending");
        if (rejectPublication) {
          throw new Error("source receiver closed");
        }
      });
      const onBlockReply = vi.fn(async () => {});
      const authority = createAgentQuestionAnswerAuthority({
        sessionKey,
        fingerprint: "source-question-policy",
        project: () => "source-question-policy",
        assertActive: () => source.signal.throwIfAborted(),
        sourceQuestionInput: { version: 1, mode: "new-task", onQuestion },
      });
      const pending = withAgentQuestionAnswerAuthority(authority, () =>
        runAgentHarnessGatewayQuestion({
          questionId,
          questions,
          sessionKey,
          timeoutMs: 60_000,
          signal: source.signal,
          delivery: { onBlockReply },
        }),
      );
      const outcome = pending.then(
        (value) => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      try {
        await fixture.waitStarted;
        await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledOnce());
        expect(onBlockReply).not.toHaveBeenCalled();
        expect(captured?.questions).toEqual(questions);
        if (rejectPublication) {
          await expect(outcome).resolves.toMatchObject({ kind: "error" });
          expect(fixture.manager.get(questionId)?.status).toBe("cancelled");
          expect(captured?.signal.aborted).toBe(true);
        } else {
          expect(captured?.signal.aborted).toBe(false);
          fixture.manager.cancel(questionId, "fixture-cleanup");
          await expect(outcome).resolves.toMatchObject({
            kind: "result",
            value: { status: "cancelled" },
          });
          expect(captured?.signal.aborted).toBe(true);
        }
      } finally {
        source.abort();
        if (fixture.manager.get(questionId)?.status === "pending") {
          fixture.manager.cancel(questionId, "fixture-cleanup");
        }
        await outcome;
      }
    });
  },
);

it("does not fall back to an operator prompt when an explicit source has no receiver", async () => {
  await withQuestionGateway(async (fixture) => {
    const source = new AbortController();
    const onBlockReply = vi.fn(async () => {});
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      fingerprint: "source-question-policy",
      project: () => "source-question-policy",
      assertActive: () => source.signal.throwIfAborted(),
      sourceQuestionInput: { version: 1, mode: "new-task" },
    });
    let rejected = false;
    const pending = withAgentQuestionAnswerAuthority(authority, () =>
      runAgentHarnessGatewayQuestion({
        questionId,
        questions,
        sessionKey,
        timeoutMs: 60_000,
        signal: source.signal,
        delivery: { onBlockReply },
      }),
    ).catch(() => {
      rejected = true;
    });
    try {
      await vi.waitFor(() => expect(rejected).toBe(true));
      expect(fixture.requests.some((request) => request.method === "question.request")).toBe(false);
      expect(onBlockReply).not.toHaveBeenCalled();
    } finally {
      source.abort();
      if (fixture.manager.get(questionId)?.status === "pending") {
        fixture.manager.cancel(questionId, "fixture-cleanup");
      }
      await pending;
    }
  });
});

it.each([false, true])(
  "keeps native ask_user publication with the source, including reserved prompts (%s)",
  async (rejectPublication) => {
    await withQuestionGateway(async (fixture) => {
      const source = new AbortController();
      const legacySend = vi.fn(async () => {});
      let captured: SourceQuestionV1 | undefined;
      const onQuestion = vi.fn(async (question: SourceQuestionV1) => {
        captured = question;
        if (rejectPublication) {
          throw new Error("source receiver closed");
        }
      });
      const authority = createAgentQuestionAnswerAuthority({
        sessionKey,
        fingerprint: "source-question-policy",
        project: () => "source-question-policy",
        assertActive: () => source.signal.throwIfAborted(),
        sourceQuestionInput: { version: 1, mode: "new-task", onQuestion },
      });
      const toolCallId = "source-question-call";
      const runId = "source-question-run";
      const reservation = reserveAskUserPromptDelivery({
        toolCallId,
        runId,
        sessionKey,
        timeoutSeconds: 60,
        questions: [
          { questionId: "seats", header: "Seats", question: "How many seats?", options: [] },
        ],
      });
      if (!reservation) {
        throw new Error("Question prompt reservation failed");
      }
      const subscriber = waitForAskUserPromptReady(reservation.questionId);
      const tool = withAgentQuestionAnswerAuthority(authority, () =>
        createAskUserTool({ sessionKey, runId, questionPrompt: { send: legacySend } }),
      );
      const pending = tool.execute(
        toolCallId,
        {
          questions: [
            {
              id: "seats",
              header: "Seats",
              question: "How many seats?",
              options: [{ label: "100" }, { label: "200" }],
            },
          ],
          timeoutSeconds: 60,
        },
        source.signal,
      );
      const outcome = pending.then(
        (value) => ({ kind: "result" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      try {
        await fixture.waitStarted;
        await vi.waitFor(() => expect(onQuestion).toHaveBeenCalledOnce());
        await expect(subscriber).resolves.toBeUndefined();
        expect(legacySend).not.toHaveBeenCalled();
        if (rejectPublication) {
          await expect(outcome).resolves.toMatchObject({ kind: "error" });
        } else {
          expect(captured?.signal.aborted).toBe(false);
          fixture.manager.cancel(reservation.questionId, "fixture-cleanup");
          await expect(outcome).resolves.toMatchObject({ kind: "result" });
        }
        expect(fixture.manager.get(reservation.questionId)?.status).toBe("cancelled");
        expect(captured?.signal.aborted).toBe(true);
      } finally {
        source.abort();
        if (fixture.manager.get(reservation.questionId)?.status === "pending") {
          fixture.manager.cancel(reservation.questionId, "fixture-cleanup");
        }
        await outcome;
        await subscriber;
      }
    });
  },
);
