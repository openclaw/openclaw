import { describe, expect, it, vi } from "vitest";
import { resolveAgentQuestionTextProgress } from "./gateway-question-progress.js";

describe("resolveAgentQuestionTextProgress", () => {
  it("uses a plain reply for the next unanswered question", async () => {
    const questionId = "ask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const sessionKey = "agent:main:telegram:direct:42";
    const callQuestion = vi.fn(async (method: string) => {
      if (method === "question.get") {
        return {
          question: {
            id: questionId,
            sessionKey,
            status: "pending",
            draftRevision: 0,
            draftCompletedIds: [],
          },
        };
      }
      return { status: "pending" };
    });
    const result = await resolveAgentQuestionTextProgress({
      questions: [
        {
          id: "target",
          header: "Target",
          question: "Where?",
          options: [{ label: "Staging" }, { label: "Review" }],
        },
        {
          id: "details",
          header: "Details",
          question: "What?",
          options: [{ label: "Logs" }, { label: "Screenshots" }],
        },
      ],
      text: "Staging",
      questionId,
      sessionKey,
      callQuestion,
    });
    expect(result).toEqual({ consumed: true, keepPending: true });
    expect(callQuestion).toHaveBeenCalledWith("question.resolve", {
      id: questionId,
      draftAnswers: { answers: { target: ["Staging"] } },
      expectedRevision: 0,
      completeQuestionId: "target",
    });
  });
});

describe("text replies across channels", () => {
  const questionId = "ask_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sessionKey = "agent:main:telegram:direct:42";
  const questions = [
    {
      id: "target",
      header: "Target",
      question: "Where?",
      options: [{ label: "Staging" }, { label: "Review" }],
    },
    {
      id: "details",
      header: "Details",
      question: "What?",
      options: [{ label: "Logs" }, { label: "Screenshots" }],
      isOther: true,
    },
  ] as const;

  it("routes a keyed custom reply to its question", async () => {
    const callQuestion = vi.fn(async (method: string) =>
      method === "question.get"
        ? { question: { status: "pending", sessionKey, draftRevision: 2 } }
        : { status: "pending" },
    );
    expect(
      await resolveAgentQuestionTextProgress({
        questions,
        text: "details: custom note",
        questionId,
        sessionKey,
        callQuestion,
      }),
    ).toEqual({ consumed: true, keepPending: true });
    expect(callQuestion).toHaveBeenCalledWith("question.resolve", {
      id: questionId,
      draftAnswers: { answers: { details: ["custom note"] } },
      expectedRevision: 2,
      completeQuestionId: "details",
    });
  });

  it("does not overwrite a question answered in another channel", async () => {
    const callQuestion = vi.fn(async () => ({
      question: { status: "pending", sessionKey, draftCompletedIds: ["details"] },
    }));
    expect(
      await resolveAgentQuestionTextProgress({
        questions,
        text: "details: custom note",
        questionId,
        sessionKey,
        callQuestion,
      }),
    ).toEqual({ consumed: true, keepPending: true });
    expect(callQuestion).toHaveBeenCalledOnce();
  });

  it("does not accept a reply for another session", async () => {
    const callQuestion = vi.fn(async () => ({
      question: { status: "pending", sessionKey: "agent:main:telegram:direct:99" },
    }));
    expect(
      await resolveAgentQuestionTextProgress({
        questions,
        text: "details: custom note",
        questionId,
        sessionKey,
        callQuestion,
      }),
    ).toEqual({ consumed: false, keepPending: false });
    expect(callQuestion).toHaveBeenCalledOnce();
  });
});
