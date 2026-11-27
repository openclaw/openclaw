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

/** Conversation binding attached to a delivered question card. */
export type FeishuQuestionCardBinding = {
  chatId?: string;
  userId?: string;
  chatType?: "p2p" | "group";
};

export type FeishuQuestionCallback =
  | { questionId: string; optionIndex: number; customInput?: never }
  | { questionId: string; customInput: true; optionIndex?: never };

/** Derive the answer binding from an outbound Feishu target ("user:..." or "chat:..."). */
export function resolveFeishuQuestionCardBinding(
  target: string | undefined,
): FeishuQuestionCardBinding | undefined {
  const trimmed = target?.trim();
  if (!trimmed) {
    return undefined;
  }
  const separator = trimmed.indexOf(":");
  const kind = separator >= 0 ? trimmed.slice(0, separator) : "";
  const id = separator >= 0 ? trimmed.slice(separator + 1).trim() : trimmed;
  if (!id) {
    return undefined;
  }
  if (kind === "user") {
    return { userId: id, chatType: "p2p" };
  }
  if (kind === "chat") {
    return { chatId: id, chatType: "group" };
  }
  return undefined;
}

/** Build the interaction envelope for a question option/custom-input button. */
export function buildFeishuQuestionButtonEnvelope(params: {
  button: MessagePresentationButton;
  questionOptionIndices?: AskUserQuestionOptionIndices;
  binding?: FeishuQuestionCardBinding;
}): FeishuCardInteractionEnvelope | undefined {
  const action = params.button.action;
  if (action?.type !== "question" || !QUESTION_RECORD_ID_PATTERN.test(action.questionId)) {
    return undefined;
  }
  const binding = params.binding;
  const context =
    binding?.userId || binding?.chatId || binding?.chatType
      ? {
          ...(binding.userId ? { u: binding.userId } : {}),
          ...(binding.chatId ? { h: binding.chatId } : {}),
          ...(binding.chatType ? { t: binding.chatType } : {}),
        }
      : undefined;
  if ("intent" in action) {
    return createFeishuCardInteractionEnvelope({
      k: "button",
      a: FEISHU_QUESTION_ACTION,
      m: { questionId: action.questionId, customInput: true },
      ...(context ? { c: context } : {}),
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
    ...(context ? { c: context } : {}),
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
