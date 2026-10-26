import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelegramInlineButtons } from "./button-types.js";
import { parseTelegramQuestionCallbackData } from "./question-callback-data.js";
import type { RichMessageButton } from "./rich-block-model.js";
import type { TelegramInputRichMessage } from "./rich-message.js";

/** Move a question's existing, authorized callbacks into the rich message body. */
export function buildTelegramQuestionRichMessage(params: {
  payload: ReplyPayload;
  buttons: TelegramInlineButtons | undefined;
}): TelegramInputRichMessage | undefined {
  const askUser = params.payload.channelData?.askUser as { questionId?: unknown } | undefined;
  if (typeof askUser?.questionId !== "string" || !params.buttons?.length) {
    return undefined;
  }
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  const question = presentation?.blocks.find((block) => block.type === "text")?.text.trim();
  if (!question) {
    return undefined;
  }
  const rows = params.buttons
    .map((row) => ({
      type: "buttons" as const,
      buttons: row.flatMap((button): RichMessageButton[] => {
        const base = {
          text: button.text,
          ...(button.style ? { style: button.style } : {}),
        };
        if (button.callback_data) {
          return [{ ...base, callback_data: button.callback_data }];
        }
        if (button.url) {
          return [{ ...base, url: button.url }];
        }
        if (button.web_app) {
          return [{ ...base, web_app: button.web_app }];
        }
        return [];
      }),
    }))
    .filter((row) => row.buttons.length > 0 && row.buttons.length <= 8);
  if (!rows.length) {
    return undefined;
  }
  return { blocks: [{ type: "paragraph", text: question }, ...rows] };
}

/** Replaces a question message with visibly selected or disabled rich buttons. */
export function updateTelegramQuestionRichMessage(params: {
  richMessage: unknown;
  questionId: string;
  questionIndex?: number;
  selectedOptionIndex?: number;
  mode: "selected" | "completed" | "inactive";
  footerText?: string;
}): TelegramInputRichMessage | undefined {
  const source = params.richMessage as { blocks?: unknown } | undefined;
  if (!Array.isArray(source?.blocks)) {
    return undefined;
  }
  const blocks = source.blocks as Array<Record<string, unknown>>;
  const firstText = blocks[0]?.text;
  if (
    blocks[0]?.type !== "paragraph" ||
    typeof firstText !== "string" ||
    !blocks.some((block) => block.type === "buttons") ||
    blocks.some((block) => !["paragraph", "buttons", "footer"].includes(String(block.type)))
  ) {
    return undefined;
  }
  const next = [] as TelegramInputRichMessage["blocks"];
  next.push({ type: "paragraph", text: firstText });
  let matched = false;
  for (const block of blocks) {
    if (block.type !== "buttons" || !Array.isArray(block.buttons)) {
      continue;
    }
    const buttons = block.buttons.flatMap((raw): RichMessageButton[] => {
      if (!raw || typeof raw !== "object") {
        return [];
      }
      const button = raw as Record<string, unknown>;
      if (typeof button.text !== "string") {
        return [];
      }
      const parsed =
        typeof button.callback_data === "string"
          ? parseTelegramQuestionCallbackData(button.callback_data)
          : null;
      const sameQuestion =
        parsed?.questionId === params.questionId &&
        (params.questionIndex === undefined || parsed.questionIndex === params.questionIndex);
      matched ||= sameQuestion;
      const selected =
        sameQuestion &&
        parsed.intent === "select" &&
        parsed.optionIndex === params.selectedOptionIndex;
      const previouslySelected = button.disabled !== undefined && button.text.startsWith("✓ ");
      const text = selected && !previouslySelected ? `✓ ${button.text}` : button.text;
      const disabled = params.mode !== "selected" || selected || button.disabled !== undefined;
      if (disabled) {
        return [{ text, disabled: {} }];
      }
      if (typeof button.callback_data === "string") {
        return [{ text, callback_data: button.callback_data }];
      }
      if (typeof button.url === "string") {
        return [{ text, url: button.url }];
      }
      return [];
    });
    if (buttons.length > 0) {
      next.push({ type: "buttons", buttons });
    }
  }
  if (!matched) {
    return undefined;
  }
  next.push({
    type: "footer",
    text:
      params.footerText ??
      (params.mode === "selected"
        ? "Choice saved. Select more or tap Done."
        : params.mode === "completed"
          ? "Answer saved."
          : "This question is no longer active."),
  });
  return { blocks: next };
}
