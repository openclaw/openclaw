import type { MessagePresentationButton } from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createFeishuCardInteractionEnvelope,
  type FeishuCardInteractionEnvelope,
} from "./card-interaction.js";

/** Card action id for an ask_user choice button rendered by the Feishu channel. */
export const FEISHU_QUESTION_ACTION = "feishu.question.answer";

const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type FeishuQuestionCallback =
  | { questionId: string; optionIndex: number; customInput?: never }
  | { questionId: string; customInput: true; optionIndex?: never };

/** Build the interaction envelope for a question option/custom-input button. */
export function buildFeishuQuestionButtonEnvelope(params: {
  button: MessagePresentationButton;
  questionOptionIndices?: AskUserQuestionOptionIndices;
}): FeishuCardInteractionEnvelope | undefined {
  const action = params.button.action;
  if (action?.type !== "question" || !QUESTION_RECORD_ID_PATTERN.test(action.questionId)) {
    return undefined;
  }
  if ("intent" in action) {
    return createFeishuCardInteractionEnvelope({
      k: "button",
      a: FEISHU_QUESTION_ACTION,
      m: { questionId: action.questionId, customInput: true },
    });
  }
  // Presentation order is not authoritative; only Gateway-owned option order can pick an index.
  const optionIndex = resolveAskUserQuestionOptionIndex({
    questionOptionIndices: params.questionOptionIndices,
    questionId: action.questionId,
    optionValue: action.optionValue,
  });
  if (optionIndex === undefined) {
    return undefined;
  }
  return createFeishuCardInteractionEnvelope({
    k: "button",
    a: FEISHU_QUESTION_ACTION,
    m: { questionId: action.questionId, optionIndex },
  });
}

/** Parse a card action envelope back into a question answer request. */
export function parseFeishuQuestionEnvelope(
  envelope: FeishuCardInteractionEnvelope,
): FeishuQuestionCallback | undefined {
  if (envelope.a !== FEISHU_QUESTION_ACTION) {
    return undefined;
  }
  const questionId = envelope.m?.questionId;
  if (typeof questionId !== "string" || !QUESTION_RECORD_ID_PATTERN.test(questionId)) {
    return undefined;
  }
  if (envelope.m?.customInput === true) {
    return { questionId, customInput: true };
  }
  const optionIndex = envelope.m?.optionIndex;
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0) {
    return undefined;
  }
  return { questionId, optionIndex };
}
