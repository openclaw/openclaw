import type { InteractiveReply, InteractiveReplyButton } from "../../../src/interactive/payload.js";
import type { TelegramInlineButton, TelegramInlineButtons } from "./button-types.js";

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

function toTelegramButtonStyle(
  style?: InteractiveReplyButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly InteractiveReplyButton[],
  rows: TelegramInlineButton[][],
) {
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE).map((button) => ({
      text: button.label,
      callback_data: button.value,
      style: toTelegramButtonStyle(button.style),
    }));
    if (row.length > 0) {
      rows.push(row);
    }
  }
}

export function buildTelegramInteractiveButtons(
  interactive?: InteractiveReply,
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  for (const block of interactive?.blocks ?? []) {
    if (block.type === "buttons") {
      chunkInteractiveButtons(block.buttons, rows);
      continue;
    }
    if (block.type === "select") {
      chunkInteractiveButtons(
        block.options.map((option) => ({
          label: option.label,
          value: option.value,
        })),
        rows,
      );
    }
  }
  return rows.length > 0 ? rows : undefined;
}
