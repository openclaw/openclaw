// Telegram plugin module implements button types behavior.
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeInteractiveReply,
  resolveMessagePresentationButtonAction,
  type InteractiveReply,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  buildTelegramApprovalCallbackData,
  hasTelegramApprovalCallbackPrefix,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";
import {
  buildTelegramNativeCommandCallbackData,
  buildTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;
const diagLogger = createSubsystemLogger("telegram/diagnostic");

function toTelegramButtonStyle(
  style?: MessagePresentationButton["style"],
): TelegramInlineButton["style"] {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
): TelegramInlineButton | undefined {
  const style = toTelegramButtonStyle(button.style);
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  if (action.type === "url") {
    return { text: button.label, url: action.url, style };
  }
  if (action.type === "web-app") {
    return { text: button.label, web_app: { url: action.url }, style };
  }
  if (action.type === "approval") {
    const callbackData = buildTelegramApprovalCallbackData(action);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  if (action.type === "command") {
    const command = rewriteTelegramApprovalDecisionAlias(action.command.trim());
    const nativeCallbackData = command
      ? sanitizeTelegramCallbackData(buildTelegramNativeCommandCallbackData(command))
      : undefined;
    // Historical approval commands may consume the full callback budget. Preserve
    // their authorized raw-command path when tgcmd: is the only overflow.
    const callbackData =
      nativeCallbackData ??
      (parseExecApprovalCommandText(command) ? sanitizeTelegramCallbackData(command) : undefined);
    return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
  }
  // Reserve the full approval prefix, including malformed values, so legacy
  // plugin callbacks cannot be consumed by the approval handler.
  const needsOpaqueEnvelope =
    Boolean(button.action) || hasTelegramApprovalCallbackPrefix(action.value);
  const callbackData = sanitizeTelegramCallbackData(
    needsOpaqueEnvelope ? buildTelegramOpaqueCallbackData(action.value) : action.value,
  );
  return callbackData ? { text: button.label, callback_data: callbackData, style } : undefined;
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
): { inputCount: number; outputCount: number } {
  let outputCount = 0;
  for (let i = 0; i < buttons.length; i += TELEGRAM_INTERACTIVE_ROW_SIZE) {
    const row = buttons
      .slice(i, i + TELEGRAM_INTERACTIVE_ROW_SIZE)
      .map(toTelegramInlineButton)
      .filter((button): button is TelegramInlineButton => Boolean(button));
    if (row.length > 0) {
      rows.push(row);
      outputCount += row.length;
    }
  }
  return { inputCount: buttons.length, outputCount };
}

function logInlineKeyboardDrops(totalInput: number, totalOutput: number) {
  const dropped = totalInput - totalOutput;
  if (dropped > 0) {
    diagLogger.warn(
      `telegram inline keyboard: ${dropped} of ${totalInput} button(s) dropped — callback_data likely exceeds Telegram 64-byte limit.` +
        (totalOutput === 0 ? " Message delivered as text-only." : ""),
    );
  }
}

/**
 * @deprecated Use buildTelegramPresentationButtons with MessagePresentation.
 */
export function buildTelegramInteractiveButtons(
  interactive?: InteractiveReply,
): TelegramInlineButtons | undefined {
  let totalInput = 0;
  const rows = reduceInteractiveReply(
    interactive,
    [] as TelegramInlineButton[][],
    (state, block) => {
      if (block.type === "buttons") {
        const counts = chunkInteractiveButtons(block.buttons, state);
        totalInput += counts.inputCount;
        return state;
      }
      if (block.type === "select") {
        const counts = chunkInteractiveButtons(
          block.options.map((option) => ({
            label: option.label,
            action: option.action,
            value: option.value,
          })),
          state,
        );
        totalInput += counts.inputCount;
      }
      return state;
    },
  );
  const totalOutput = rows.reduce((sum, row) => sum + row.length, 0);
  logInlineKeyboardDrops(totalInput, totalOutput);
  return rows.length > 0 ? rows : undefined;
}

/** Convert portable presentation controls to Telegram inline keyboard rows. */
export function buildTelegramPresentationButtons(
  presentation?: MessagePresentation,
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  let totalInput = 0;
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    if (block.type === "buttons") {
      const counts = chunkInteractiveButtons(block.buttons, rows);
      totalInput += counts.inputCount;
      continue;
    }
    const counts = chunkInteractiveButtons(
      block.options.map((option) => ({
        label: option.label,
        action: option.action,
        value: option.value,
      })),
      rows,
    );
    totalInput += counts.inputCount;
  }
  const totalOutput = rows.reduce((sum, row) => sum + row.length, 0);
  logInlineKeyboardDrops(totalInput, totalOutput);
  return rows.length > 0 ? rows : undefined;
}

/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
export function resolveTelegramInlineButtons(params: {
  buttons?: TelegramInlineButtons;
  presentation?: unknown;
  interactive?: unknown;
}): TelegramInlineButtons | undefined {
  return (
    params.buttons ??
    buildTelegramInteractiveButtons(normalizeInteractiveReply(params.interactive)) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation))
  );
}
