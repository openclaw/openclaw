// Tests the Telegram question inline-keyboard payload shape: option buttons
// encode the native `/answer <n>` command, an "Other" button routes to /answer,
// and multi-part prompts render no keyboard (text /answer fallback).
import { describe, expect, it } from "vitest";
import {
  buildQuestionInlineKeyboard,
  TELEGRAM_QUESTION_OTHER_BUTTON_LABEL,
} from "./question-keyboard.js";

describe("buildQuestionInlineKeyboard", () => {
  it("renders one button per option plus Other, encoding /answer <n> commands", () => {
    const keyboard = buildQuestionInlineKeyboard({
      id: "rec-1",
      questions: [
        {
          id: "q1",
          header: "Deploy",
          question: "Ship it?",
          isOther: true,
          options: [{ label: "Yes (Recommended)" }, { label: "No" }],
        },
      ],
    });
    expect(keyboard).toEqual([
      [{ text: "Yes (Recommended)", callback_data: "tgcmd:/answer 1" }],
      [{ text: "No", callback_data: "tgcmd:/answer 2" }],
      [{ text: TELEGRAM_QUESTION_OTHER_BUTTON_LABEL, callback_data: "tgcmd:/answer" }],
    ]);
  });

  it("omits the Other button when isOther is explicitly false", () => {
    const keyboard = buildQuestionInlineKeyboard({
      id: "rec-1",
      questions: [
        { id: "q1", header: "Pick", question: "Which?", isOther: false, options: [{ label: "A" }] },
      ],
    });
    expect(keyboard).toEqual([[{ text: "A", callback_data: "tgcmd:/answer 1" }]]);
  });

  it("renders an Other-only keyboard for an options-less question", () => {
    const keyboard = buildQuestionInlineKeyboard({
      id: "rec-1",
      questions: [{ id: "q1", header: "Free", question: "Say?", isOther: true }],
    });
    expect(keyboard).toEqual([
      [{ text: TELEGRAM_QUESTION_OTHER_BUTTON_LABEL, callback_data: "tgcmd:/answer" }],
    ]);
  });

  it("renders no keyboard for a multi-part prompt (text /answer fallback)", () => {
    expect(
      buildQuestionInlineKeyboard({
        id: "rec-1",
        questions: [
          { id: "q1", header: "A", question: "1?", isOther: true },
          { id: "q2", header: "B", question: "2?", isOther: true },
        ],
      }),
    ).toBeUndefined();
  });
});
