/** Applies one text answer to the intended question without ending the whole wait. */
import type {
  QuestionGetResult,
  QuestionResolveResult,
} from "../../../packages/gateway-protocol/src/schema/questions.js";
import { readQuestionRejection } from "../tools/gateway-question-lifecycle.js";
import { QuestionAnswerUnconfirmedError } from "./gateway-question-dispatch.js";
import { buildAgentHarnessUserInputAnswers } from "./user-input-bridge.js";
import type { AgentHarnessUserInputQuestion } from "./user-input-types.js";

export type QuestionTextProgress = { consumed: boolean; keepPending: boolean };

export async function resolveAgentQuestionTextProgress(params: {
  questions: readonly AgentHarnessUserInputQuestion[];
  text: string;
  questionId: string;
  sessionKey: string;
  callQuestion: (method: string, request: unknown) => Promise<unknown>;
}): Promise<QuestionTextProgress | null> {
  const { questions, text, questionId, sessionKey, callQuestion } = params;
  const keyedInput = questions.length > 1 ? text.trim().match(/^([^:\n]{1,64}):\s*(.+)$/u) : null;
  let targetQuestion = keyedInput
    ? questions.find((question, index) =>
        [question.id, question.header, String(index + 1)].some(
          (key) => key?.toLowerCase() === keyedInput[1]?.trim().toLowerCase(),
        ),
      )
    : undefined;
  let targetText = keyedInput?.[2];
  if (!targetQuestion && !keyedInput && questions.length > 1 && !text.includes("\n")) {
    const observed = (await callQuestion("question.get", { id: questionId }).catch(
      () => undefined,
    )) as QuestionGetResult | undefined;
    if (observed?.question.status === "pending" && observed.question.sessionKey === sessionKey) {
      const remaining = questions.filter(
        (question) => !observed.question.draftCompletedIds?.includes(question.id),
      );
      if (remaining.length > 0) {
        targetQuestion = remaining[0];
        targetText = text.trim();
      }
    }
  }
  if (!targetQuestion || !targetText) {
    return null;
  }
  const values =
    buildAgentHarnessUserInputAnswers([targetQuestion], targetText).answers[targetQuestion.id]
      ?.answers ?? [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const observed = (await callQuestion("question.get", { id: questionId })) as QuestionGetResult;
    const record = observed.question;
    if (record.status !== "pending" || record.sessionKey !== sessionKey) {
      return { consumed: false, keepPending: false };
    }
    const saved = record.draftAnswers?.answers[targetQuestion.id] ?? [];
    const next = targetQuestion.multiSelect ? [...new Set([...saved, ...values])] : values;
    if (record.draftCompletedIds?.includes(targetQuestion.id)) {
      // Another channel already completed this question. Consume stale text
      // without replacing its answer or starting another agent turn.
      return { consumed: true, keepPending: true };
    }
    try {
      const result = (await callQuestion("question.resolve", {
        id: questionId,
        draftAnswers: { answers: { [targetQuestion.id]: next } },
        expectedRevision: record.draftRevision ?? 0,
        completeQuestionId: targetQuestion.id,
      })) as QuestionResolveResult;
      return { consumed: true, keepPending: result.status === "pending" };
    } catch (error) {
      const rejection = readQuestionRejection(error);
      if (rejection?.reason === "QUESTION_DRAFT_CONFLICT") {
        if (attempt === 0) {
          continue;
        }
        throw error;
      }
      if (rejection?.code === "INVALID_REQUEST" || rejection?.code === "FORBIDDEN") {
        throw error;
      }
      // A lost ACK may follow a committed draft. Only an observed matching
      // completion proves this text was consumed; never replay it blindly.
      const verified = (await callQuestion("question.get", { id: questionId }).catch(
        () => undefined,
      )) as QuestionGetResult | undefined;
      const accepted = verified?.question.draftAnswers?.answers[targetQuestion.id] ?? [];
      if (
        verified?.question.draftCompletedIds?.includes(targetQuestion.id) &&
        accepted.length === next.length &&
        accepted.every((value, index) => value === next[index])
      ) {
        return { consumed: true, keepPending: true };
      }
      throw new QuestionAnswerUnconfirmedError(error);
    }
  }
  throw new Error("question draft conflict retry exhausted");
}
