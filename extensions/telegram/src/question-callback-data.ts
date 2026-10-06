// Telegram-private ask_user callback envelope.
const TELEGRAM_QUESTION_CALLBACK_PREFIXES = ["tgq1:", "tgqo1:"] as const;
// Fixed question IDs and option indices keep both envelopes below Telegram's 64-byte limit.
const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;

export type TelegramQuestionCallback =
  | { questionId: string; intent: "select"; optionIndex: number }
  | { questionId: string; intent: "custom-input" };

export function hasTelegramQuestionCallbackPrefix(data?: string | null): boolean {
  return TELEGRAM_QUESTION_CALLBACK_PREFIXES.some((prefix) => data?.startsWith(prefix) === true);
}

export function buildTelegramQuestionCallbackData(
  callback:
    | Extract<TelegramQuestionCallback, { intent: "select" }>
    | {
        questionId: string;
        optionIndex: number;
      },
): string | undefined {
  if (
    !QUESTION_RECORD_ID_PATTERN.test(callback.questionId) ||
    !Number.isInteger(callback.optionIndex) ||
    callback.optionIndex < 0 ||
    callback.optionIndex > 3
  ) {
    return undefined;
  }
  return `tgq1:${callback.questionId}:${callback.optionIndex}`;
}

export function buildTelegramQuestionCustomInputCallbackData(
  questionId: string,
): string | undefined {
  if (!QUESTION_RECORD_ID_PATTERN.test(questionId)) {
    return undefined;
  }
  return `tgqo1:${questionId}`;
}

export function parseTelegramQuestionCallbackData(
  data?: string | null,
): TelegramQuestionCallback | null {
  if (!data) {
    return null;
  }
  const selectMatch = /^tgq1:(ask_[a-f0-9]{32}):([0-3])$/u.exec(data);
  if (selectMatch?.[1] && selectMatch[2]) {
    return { questionId: selectMatch[1], intent: "select", optionIndex: Number(selectMatch[2]) };
  }
  const customInputMatch = /^tgqo1:(ask_[a-f0-9]{32})$/u.exec(data);
  return customInputMatch?.[1] ? { questionId: customInputMatch[1], intent: "custom-input" } : null;
}
