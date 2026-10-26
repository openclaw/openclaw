// Telegram question callback feedback tests.
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  handleTelegramQuestionCallback,
  sendTelegramQuestionFeedback,
  createTelegramCallbackMessageActions,
  type TelegramCallbackMessageActions,
} from "./bot-handlers.callback-actions.js";

const callback = {
  questionId: "ask_0123456789abcdef0123456789abcdef",
  intent: "select" as const,
  optionIndex: 1,
};

function createCallbackActions() {
  const clearCallbackButtons = vi.fn<TelegramCallbackMessageActions["clearCallbackButtons"]>();
  clearCallbackButtons.mockResolvedValue(true);
  return {
    editCallbackMessage: vi.fn<TelegramCallbackMessageActions["editCallbackMessage"]>(),
    clearCallbackButtons,
    editCallbackButtons: vi.fn<TelegramCallbackMessageActions["editCallbackButtons"]>(),
    editCallbackQuestionRichMessage:
      vi.fn<TelegramCallbackMessageActions["editCallbackQuestionRichMessage"]>(),
    editCallbackMessageWithButtons:
      vi.fn<TelegramCallbackMessageActions["editCallbackMessageWithButtons"]>(),
    deleteCallbackMessage: vi.fn<TelegramCallbackMessageActions["deleteCallbackMessage"]>(),
    replyToCallbackChat: vi.fn<TelegramCallbackMessageActions["replyToCallbackChat"]>(),
  } satisfies TelegramCallbackMessageActions;
}

describe("sendTelegramQuestionFeedback", () => {
  it("keeps question controls available after requesting custom input", async () => {
    const actions = createCallbackActions();

    await sendTelegramQuestionFeedback({
      actions,
      text: "Reply with your own answer.",
      mode: "custom-input",
      isGroup: false,
      user: { id: 42, is_bot: false, first_name: "Ayaan" },
    });

    expect(actions.replyToCallbackChat).toHaveBeenCalledOnce();
    expect(actions.clearCallbackButtons).not.toHaveBeenCalled();
  });

  it("keeps question controls when Telegram rejects the custom-input prompt", async () => {
    const actions = createCallbackActions();
    actions.replyToCallbackChat.mockRejectedValue(new Error("send rejected"));

    await expect(
      sendTelegramQuestionFeedback({
        actions,
        text: "Reply with your own answer.",
        mode: "custom-input",
        isGroup: false,
        user: { id: 42, is_bot: false, first_name: "Ayaan" },
      }),
    ).rejects.toThrow("send rejected");

    expect(actions.clearCallbackButtons).not.toHaveBeenCalled();
  });
});

describe("handleTelegramQuestionCallback", () => {
  it("does not turn a committed answer into an error when feedback fails", async () => {
    using _ = vi.spyOn(questionGatewayRuntime, "resolveOption").mockResolvedValue({
      status: "answered",
      questionId: "target",
      optionValue: "Production",
    });
    const feedback = vi.fn(async () => {
      throw new Error("receipt failed");
    });

    await expect(
      handleTelegramQuestionCallback({
        callback,
        cfg: {} as never,
        senderId: "42",
        feedback,
      }),
    ).resolves.toBeUndefined();
    expect(feedback).toHaveBeenCalledOnce();
  });
  it("prompts for a keyed custom answer on an indexed question", async () => {
    const feedback = vi.fn(async () => {});
    await handleTelegramQuestionCallback({
      callback: {
        questionId: callback.questionId,
        questionIndex: 1,
        intent: "custom-input",
      },
      cfg: {} as never,
      senderId: "42",
      feedback,
      resolveQuestion: vi.fn(async () => ({
        status: "custom-input" as const,
        questionId: "details",
      })),
    });
    expect(feedback).toHaveBeenCalledWith(
      'Reply with your answer. To answer out of order, use "details: your answer".',
      "custom-input",
    );
  });
});

describe("rich question callback updates", () => {
  it("edits the clicked message after an accepted answer without posting a duplicate receipt", async () => {
    const updateRichMessage = vi.fn(async () => true);
    const feedback = vi.fn(async () => {});
    await handleTelegramQuestionCallback({
      callback: { ...callback, questionIndex: 0 },
      cfg: {} as never,
      senderId: "42",
      updateRichMessage,
      feedback,
      resolveQuestion: vi.fn(async () => ({
        status: "pending" as const,
        questionId: "target",
        optionValue: "Staging",
        selectedValues: ["Staging"],
        completed: true,
      })),
    });
    expect(updateRichMessage).toHaveBeenCalledWith({
      questionId: callback.questionId,
      questionIndex: 0,
      selectedOptionIndex: 1,
      mode: "completed",
    });
    expect(feedback).not.toHaveBeenCalled();
  });

  it("turns a stale rich callback inactive without another task continuation", async () => {
    const updateRichMessage = vi.fn(async () => true);
    const feedback = vi.fn(async () => {});
    const resolveQuestion = vi.fn(async () => ({
      status: "already-terminal" as const,
      reason: "already-terminal" as const,
    }));
    await handleTelegramQuestionCallback({
      callback,
      cfg: {} as never,
      senderId: "42",
      updateRichMessage,
      feedback,
      resolveQuestion,
    });
    expect(resolveQuestion).toHaveBeenCalledOnce();
    expect(updateRichMessage).toHaveBeenCalledWith({
      questionId: callback.questionId,
      selectedOptionIndex: 1,
      mode: "inactive",
    });
    expect(feedback).not.toHaveBeenCalled();
  });

  it("sends disabled rich buttons through Telegram editMessageText", async () => {
    const edit = vi.fn(async () => ({}));
    const actions = createTelegramCallbackMessageActions({
      bot: { api: { raw: { editMessageText: edit } } } as never,
      callbackMessage: {
        chat: { id: 42 },
        message_id: 99,
        rich_message: {
          blocks: [
            { type: "paragraph", text: "Choose a target" },
            {
              type: "buttons",
              buttons: [{ text: "Staging", callback_data: `tgq1:${callback.questionId}:0` }],
            },
            {
              type: "buttons",
              buttons: [{ text: "Review", callback_data: `tgq1:${callback.questionId}:1` }],
            },
          ],
        },
      } as never,
      threadSpec: {} as never,
    });
    expect(
      await actions.editCallbackQuestionRichMessage({
        questionId: callback.questionId,
        selectedOptionIndex: 0,
        mode: "completed",
      }),
    ).toBe(true);
    expect(edit).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: 42,
        message_id: 99,
        rich_message: {
          blocks: [
            { type: "paragraph", text: "Choose a target" },
            { type: "buttons", buttons: [{ text: "✓ Staging", disabled: {} }] },
            { type: "buttons", buttons: [{ text: "Review", disabled: {} }] },
            { type: "footer", text: "Answer saved." },
          ],
        },
      }),
    );
  });
});
