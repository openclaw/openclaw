// Telegram inline-keyboard rendering for ask_user_question prompts.
//
// Extends the existing inline-button path: each option becomes a button whose
// callback runs the native `/answer <n>` command (routed through the same
// native-command callback handler as other Telegram command buttons), so the
// pending question resolves via the shared /answer handler. A free-text "Other"
// button routes to `/answer`, which replies with usage prompting a typed answer.
import { sanitizeTelegramCallbackData } from "./approval-callback-data.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

export const TELEGRAM_QUESTION_OTHER_BUTTON_LABEL = "✏️ Other";

type QuestionOption = { label: string; description?: string };
type QuestionItem = {
  id: string;
  header: string;
  question: string;
  options?: readonly QuestionOption[] | null;
  isOther?: boolean;
};

/** Minimal shape of a `question.pending` event payload used for rendering. */
export type TelegramQuestionPrompt = {
  id: string;
  questions: readonly QuestionItem[];
};

function commandButton(text: string, command: string) {
  const callbackData = sanitizeTelegramCallbackData(
    buildTelegramNativeCommandCallbackData(command),
  );
  return callbackData ? { text, callback_data: callbackData } : undefined;
}

/**
 * Builds the inline keyboard for a pending question. Buttons are only rendered
 * for a single-question prompt (multi-part prompts are answered via the numbered
 * `/answer` text fallback). Returns undefined when there is nothing to render.
 */
export function buildQuestionInlineKeyboard(
  prompt: TelegramQuestionPrompt,
): TelegramInlineButtons | undefined {
  if (prompt.questions.length !== 1) {
    return undefined;
  }
  const question = prompt.questions[0];
  const options = question?.options ?? [];
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  options.forEach((option, index) => {
    const button = commandButton(option.label, `/answer ${index + 1}`);
    if (button) {
      rows.push([button]);
    }
  });
  // isOther defaults to true (the tool always appends a free-form option).
  if (question?.isOther !== false) {
    const other = commandButton(TELEGRAM_QUESTION_OTHER_BUTTON_LABEL, "/answer");
    if (other) {
      rows.push([other]);
    }
  }
  return rows.length > 0 ? rows : undefined;
}
