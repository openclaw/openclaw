// Tests Slack question rendering: the portable interactive reply carries option
// buttons as /answer <n> commands (+ Other), and buildSlackInteractiveBlocks
// turns them into an actions block with one button element per option.
import { describe, expect, it } from "vitest";
import {
  buildQuestionAnswerBlocks,
  buildQuestionInteractiveReply,
  SLACK_QUESTION_OTHER_BUTTON_LABEL,
} from "./question-blocks.js";

const PROMPT = {
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
};

describe("Slack question rendering", () => {
  it("builds a portable reply with option buttons as /answer <n> commands plus Other", () => {
    expect(buildQuestionInteractiveReply(PROMPT)).toEqual({
      blocks: [
        { type: "text", text: "*Deploy*\nShip it?" },
        {
          type: "buttons",
          buttons: [
            { label: "Yes (Recommended)", action: { type: "callback", value: "/answer 1" } },
            { label: "No", action: { type: "callback", value: "/answer 2" } },
            {
              label: SLACK_QUESTION_OTHER_BUTTON_LABEL,
              action: { type: "callback", value: "/answer" },
            },
          ],
        },
      ],
    });
  });

  it("renders an actions block with one button element per option/Other", () => {
    const blocks = buildQuestionAnswerBlocks(PROMPT);
    const actions = blocks.find((block) => block.type === "actions") as
      | {
          type: "actions";
          elements: Array<{ type: string; text: { text: string }; value?: string }>;
        }
      | undefined;
    expect(actions).toBeDefined();
    expect(actions?.elements.map((element) => element.text.text)).toEqual([
      "Yes (Recommended)",
      "No",
      SLACK_QUESTION_OTHER_BUTTON_LABEL,
    ]);
    // The command travels as the button value so the click routes to /answer.
    expect(actions?.elements.map((element) => element.value)).toEqual([
      "/answer 1",
      "/answer 2",
      "/answer",
    ]);
    // The question text renders as a section block.
    expect(blocks.some((block) => block.type === "section")).toBe(true);
  });

  it("renders no blocks for a multi-part prompt (text /answer fallback)", () => {
    expect(
      buildQuestionAnswerBlocks({
        id: "rec-1",
        questions: [
          { id: "q1", header: "A", question: "1?", isOther: true },
          { id: "q2", header: "B", question: "2?", isOther: true },
        ],
      }),
    ).toEqual([]);
  });
});
