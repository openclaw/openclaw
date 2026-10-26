import { describe, expect, it } from "vitest";
import { buildAgentHarnessQuestionPromptPayload } from "../../../src/agents/harness/user-input-bridge.js";
import { resolveTelegramInlineButtons } from "./button-types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import {
  buildTelegramQuestionRichMessage,
  updateTelegramQuestionRichMessage,
} from "./question-rich-message.js";

const questionId = "ask_0123456789abcdef0123456789abcdef";

describe("rich question buttons", () => {
  it("keeps callback identity for a multi-select question within its own message", () => {
    const prompt = buildAgentHarnessQuestionPromptPayload({
      questionId,
      questionIndex: 1,
      questions: [
        {
          id: "details",
          header: "Details",
          question: "Choose details",
          options: [{ label: "Logs" }, { label: "Screenshots" }],
          multiSelect: true,
          isOther: true,
        },
      ],
    });
    const canonical = canonicalizeTelegramPresentationPayload(prompt, { richTables: true });
    const telegram = canonical.channelData?.telegram as
      | { buttons?: Parameters<typeof resolveTelegramInlineButtons>[0]["buttons"] }
      | undefined;
    const rich = buildTelegramQuestionRichMessage({
      payload: prompt,
      buttons: resolveTelegramInlineButtons({ buttons: telegram?.buttons }),
    });
    expect(rich?.blocks[0]).toEqual({ type: "paragraph", text: "Choose details" });
    expect(rich?.blocks.filter((block) => block.type === "buttons")).toMatchObject([
      { buttons: [{ text: "Logs", callback_data: `tgq2:${questionId}:1:0:a` }] },
      { buttons: [{ text: "Screenshots", callback_data: `tgq2:${questionId}:1:1:a` }] },
      { buttons: [{ text: "Done" }] },
      { buttons: [{ text: "Other…" }] },
    ]);
  });

  it("never turns an unrelated message into a rich question", () => {
    expect(
      buildTelegramQuestionRichMessage({
        payload: { text: "Hi" },
        buttons: [[{ text: "A", callback_data: "a" }]],
      }),
    ).toBeUndefined();
  });
});

describe("rich question answer state", () => {
  const initial = {
    blocks: [
      { type: "paragraph", text: "Choose details" },
      { type: "buttons", buttons: [{ text: "Logs", callback_data: `tgq2:${questionId}:1:0:a` }] },
      {
        type: "buttons",
        buttons: [{ text: "Screenshots", callback_data: `tgq2:${questionId}:1:1:a` }],
      },
      { type: "buttons", buttons: [{ text: "Done", callback_data: `tgqd2:${questionId}:1` }] },
      { type: "buttons", buttons: [{ text: "Other…", callback_data: `tgqo2:${questionId}:1` }] },
    ],
  };

  it("marks each selected option once while other choices and Done remain available", () => {
    const first = updateTelegramQuestionRichMessage({
      richMessage: initial,
      questionId,
      questionIndex: 1,
      selectedOptionIndex: 0,
      mode: "selected",
    });
    expect(first?.blocks[1]).toMatchObject({ buttons: [{ text: "✓ Logs", disabled: {} }] });
    expect(first?.blocks[2]).toMatchObject({
      buttons: [{ text: "Screenshots", callback_data: expect.any(String) }],
    });
    const second = updateTelegramQuestionRichMessage({
      richMessage: first,
      questionId,
      questionIndex: 1,
      selectedOptionIndex: 1,
      mode: "selected",
    });
    expect(second?.blocks[1]).toMatchObject({ buttons: [{ text: "✓ Logs", disabled: {} }] });
    expect(second?.blocks[2]).toMatchObject({ buttons: [{ text: "✓ Screenshots", disabled: {} }] });
    expect(second?.blocks[3]).toMatchObject({
      buttons: [{ text: "Done", callback_data: expect.any(String) }],
    });
  });

  it("disables all controls when the question is complete", () => {
    const final = updateTelegramQuestionRichMessage({
      richMessage: initial,
      questionId,
      questionIndex: 1,
      selectedOptionIndex: 0,
      mode: "completed",
    });
    expect(final?.blocks.slice(1, 5)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ buttons: [{ text: "✓ Logs", disabled: {} }] }),
        expect.objectContaining({ buttons: [{ text: "Screenshots", disabled: {} }] }),
        expect.objectContaining({ buttons: [{ text: "Done", disabled: {} }] }),
      ]),
    );
  });
});
