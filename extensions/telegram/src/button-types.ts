import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  normalizeInteractiveReply,
  type InteractiveReply,
  type InteractiveReplyButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { sanitizeTelegramCallbackData } from "./approval-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

export type TelegramInlineButtonBase = {
  text: string;
  style?: TelegramButtonStyle;
};

export type TelegramInlineButton =
  | (TelegramInlineButtonBase & {
      callback_data: string;
    })
  | (TelegramInlineButtonBase & {
      url: string;
    })
  | (TelegramInlineButtonBase & {
      web_app: {
        url: string;
      };
    });

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;
export type TelegramUrlButtonMode = "url" | "web_app";

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

function toTelegramButtonStyle(
  style?: InteractiveReplyButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function buildTelegramInteractiveButton(
  button: InteractiveReplyButton,
  urlButtonMode: TelegramUrlButtonMode,
): TelegramInlineButton | undefined {
  if (button.url) {
    return urlButtonMode === "web_app" && isHttpsUrl(button.url)
      ? {
          text: button.label,
          web_app: { url: button.url },
          style: toTelegramButtonStyle(button.style),
        }
      : {
          text: button.label,
          url: button.url,
          style: toTelegramButtonStyle(button.style),
        };
  }
  if (!button.value) {
    return undefined;
  }
  const callbackData = sanitizeTelegramCallbackData(button.value);
  return callbackData
    ? {
        text: button.label,
        callback_data: callbackData,
        style: toTelegramButtonStyle(button.style),
      }
    : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly InteractiveReplyButton[],
  rows: TelegramInlineButton[][],
  urlButtonMode: TelegramUrlButtonMode,
) {
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons.slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE).flatMap((button) => {
      const telegramButton = buildTelegramInteractiveButton(button, urlButtonMode);
      return telegramButton ? [telegramButton] : [];
    });
    if (row.length > 0) {
      rows.push(row);
    }
  }
}

export function buildTelegramInteractiveButtons(
  interactive?: InteractiveReply,
  opts?: { urlButtonMode?: TelegramUrlButtonMode },
): TelegramInlineButtons | undefined {
  const urlButtonMode = opts?.urlButtonMode ?? "url";
  const rows = reduceInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        chunkInteractiveButtons(block.buttons, state, urlButtonMode);
        return state;
      }
      if (block.type === "select") {
        chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
          state,
          urlButtonMode,
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
  urlButtonMode?: TelegramUrlButtonMode;
}): TelegramInlineButtons | undefined {
  return (
    params.buttons ??
    buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive), {
      urlButtonMode: params.urlButtonMode,
    })
  );
}
