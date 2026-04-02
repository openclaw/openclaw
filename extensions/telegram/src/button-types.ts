import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  normalizeInteractiveReply,
  type InteractiveReply,
  type InteractiveReplyButton,
} from "openclaw/plugin-sdk/interactive-runtime";

export type TelegramButtonStyle = "danger" | "success" | "primary";

export type TelegramInlineButton = {
  text: string;
  callback_data: string;
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;
const MAX_CALLBACK_DATA_BYTES = 64;

function fitsTelegramCallbackData(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= MAX_CALLBACK_DATA_BYTES;
}

function toTelegramButtonStyle(
  style?: InteractiveReplyButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function rewriteTelegramApprovalAlias(value: string): string {
  if (!value.endsWith(" allow-always")) {
    return value;
  }
  const approvePrefixMatch = value.match(
    /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+allow-always$/i,
  );
  if (!approvePrefixMatch) {
    return value;
  }
  return value.slice(0, -"allow-always".length) + "always";
}

function chunkInteractiveButtons(
  buttons: readonly InteractiveReplyButton[],
  rows: TelegramInlineButton[][],
) {
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons
      .slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE)
      .map((button) => ({
        ...button,
        value: rewriteTelegramApprovalAlias(button.value),
      }))
      .filter((button) => fitsTelegramCallbackData(button.value))
      .map((button) => ({
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
  const rows = reduceInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        chunkInteractiveButtons(block.buttons, state);
        return state;
      }
      if (block.type === "select") {
        chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
          state,
        );
      }
      return state;
    },
  );
  return rows.length > 0 ? rows : undefined;
}

export function resolveTelegramInlineButtons(params: {
  buttons?: TelegramInlineButtons;
  interactive?: unknown;
}): TelegramInlineButtons | undefined {
  return (
    params.buttons ?? buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive))
  );
}
