// Slack Block Kit rendering for ask_user_question prompts.
//
// Extends the existing interactive-blocks path: the question becomes a portable
// InteractiveReply whose option buttons carry the `/answer <n>` text as their
// callback value. Slack restricts command-type button actions to exec-approval
// commands, so questions use the callback (reply-button) path — clicking posts
// "/answer <n>" back through the message pipeline, resolving via the shared
// /answer handler. Rendering delegates to buildSlackInteractiveBlocks so the
// action_id/value contract matches the existing reply buttons exactly.
import type {
  InteractiveReply,
  InteractiveReplyButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { buildSlackInteractiveBlocks, type SlackBlock } from "./blocks-render.js";

export const SLACK_QUESTION_OTHER_BUTTON_LABEL = "✏️ Other";

type QuestionOption = { label: string; description?: string };
type QuestionItem = {
  id: string;
  header: string;
  question: string;
  options?: readonly QuestionOption[] | null;
  isOther?: boolean;
};

/** Minimal shape of a `question.pending` event payload used for rendering. */
export type SlackQuestionPrompt = {
  id: string;
  questions: readonly QuestionItem[];
};

function answerButton(label: string, command: string): InteractiveReplyButton {
  // Callback (not command) action: Slack only renders command-type buttons for
  // exec-approval commands, so the /answer text travels as the callback value.
  return { label, action: { type: "callback", value: command } };
}

/**
 * Builds the portable interactive reply for a single-question prompt. Multi-part
 * prompts render no buttons (answered via the numbered `/answer` text fallback).
 */
export function buildQuestionInteractiveReply(
  prompt: SlackQuestionPrompt,
): InteractiveReply | undefined {
  if (prompt.questions.length !== 1) {
    return undefined;
  }
  const question = prompt.questions[0];
  const options = question?.options ?? [];
  const buttons: InteractiveReplyButton[] = options.map((option, index) =>
    answerButton(option.label, `/answer ${index + 1}`),
  );
  if (question?.isOther !== false) {
    buttons.push(answerButton(SLACK_QUESTION_OTHER_BUTTON_LABEL, "/answer"));
  }
  if (buttons.length === 0) {
    return undefined;
  }
  const text = question ? `*${question.header}*\n${question.question}` : "";
  return {
    blocks: [...(text ? [{ type: "text" as const, text }] : []), { type: "buttons", buttons }],
  };
}

/** Renders the Slack Block Kit blocks for a pending question (empty when nothing to render). */
export function buildQuestionAnswerBlocks(prompt: SlackQuestionPrompt): SlackBlock[] {
  const interactive = buildQuestionInteractiveReply(prompt);
  return interactive ? buildSlackInteractiveBlocks(interactive) : [];
}
