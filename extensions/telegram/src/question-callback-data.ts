// Telegram-private ask_user callback envelope.
const TELEGRAM_QUESTION_CALLBACK_PREFIXES = [
  "tgq1:",
  "tgqo1:",
  "tgq2:",
  "tgqo2:",
  "tgqd2:",
] as const;
// Fixed question IDs and option indices keep both envelopes below Telegram's 64-byte limit.
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type TelegramQuestionCallback =
  | {
      questionId: string;
      intent: "select";
      optionIndex: number;
      questionIndex?: number;
      selected?: boolean;
    }
  | { questionId: string; intent: "custom-input"; questionIndex?: number }
  | { questionId: string; intent: "done"; questionIndex: number };

export function hasTelegramQuestionCallbackPrefix(data?: string | null): boolean {
  return TELEGRAM_QUESTION_CALLBACK_PREFIXES.some((prefix) => data?.startsWith(prefix) === true);
}

export function buildTelegramQuestionCallbackData(callback: {
  questionId: string;
  optionIndex: number;
  questionIndex?: number;
  selected?: boolean;
}): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(callback.questionId) ||
    !Number.isInteger(callback.optionIndex) ||
    callback.optionIndex < 0 ||
    callback.optionIndex > 63
  ) {
    return undefined;
  }
  if (callback.questionIndex === undefined && callback.optionIndex <= 3) {
    return `tgq1:${callback.questionId}:${callback.optionIndex}`;
  }
  if (
    callback.questionIndex === undefined ||
    !Number.isInteger(callback.questionIndex) ||
    callback.questionIndex < 0 ||
    callback.questionIndex > 2
  ) {
    return undefined;
  }
  return `tgq2:${callback.questionId}:${callback.questionIndex}:${callback.optionIndex}:${callback.selected === false ? "r" : "a"}`;
}

export function buildTelegramQuestionCustomInputCallbackData(
  questionId: string,
  questionIndex?: number,
): string | undefined {
  if (!QUESTION_RECORD_ID_PATTERN.test(questionId)) {
    return undefined;
  }
  if (questionIndex === undefined) {
    return `tgqo1:${questionId}`;
  }
  return Number.isInteger(questionIndex) && questionIndex >= 0 && questionIndex <= 2
    ? `tgqo2:${questionId}:${questionIndex}`
    : undefined;
}

export function buildTelegramQuestionDoneCallbackData(
  questionId: string,
  questionIndex: number,
): string | undefined {
  return QUESTION_RECORD_ID_PATTERN.test(questionId) &&
    Number.isInteger(questionIndex) &&
    questionIndex >= 0 &&
    questionIndex <= 2
    ? `tgqd2:${questionId}:${questionIndex}`
    : undefined;
}

export function parseTelegramQuestionCallbackData(
  data?: string | null,
): TelegramQuestionCallback | null {
  if (!data) {
    return null;
  }
  const batchSelect = /^tgq2:(ask_[a-f0-9]{32}):([0-2]):([0-9]|[1-5][0-9]|6[0-3]):([ar])$/u.exec(
    data,
  );
  if (batchSelect?.[1]) {
    return {
      questionId: batchSelect[1],
      intent: "select",
      questionIndex: Number(batchSelect[2]),
      optionIndex: Number(batchSelect[3]),
      selected: batchSelect[4] === "a",
    };
  }
  const batchOther = /^tgqo2:(ask_[a-f0-9]{32}):([0-2])$/u.exec(data);
  if (batchOther?.[1]) {
    return {
      questionId: batchOther[1],
      intent: "custom-input",
      questionIndex: Number(batchOther[2]),
    };
  }
  const done = /^tgqd2:(ask_[a-f0-9]{32}):([0-2])$/u.exec(data);
  if (done?.[1]) {
    return { questionId: done[1], intent: "done", questionIndex: Number(done[2]) };
  }
  const selectMatch = /^tgq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(data);
  if (selectMatch?.[1] && selectMatch[2]) {
    return { questionId: selectMatch[1], intent: "select", optionIndex: Number(selectMatch[2]) };
  }
  const customInputMatch = /^tgqo1:(ask_[a-f0-9]{32})$/u.exec(data);
  return customInputMatch?.[1] ? { questionId: customInputMatch[1], intent: "custom-input" } : null;
}
