import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndex,
  type AskUserQuestionOptionIndices,
} from "openclaw/plugin-sdk/reply-payload";
import {
  buildTelegramApprovalCallbackData,
  TELEGRAM_CALLBACK_DATA_MAX_BYTES,
  hasTelegramApprovalCallbackPrefix,
  rewriteTelegramApprovalDecisionAlias,
  sanitizeTelegramCallbackData,
} from "./approval-callback-data.js";
import {
  buildTelegramNativeCommandCallbackData,
  buildTelegramOpaqueCallbackData,
} from "./native-command-callback-data.js";
import {
  buildTelegramQuestionCallbackData,
  buildTelegramQuestionCustomInputCallbackData,
  hasTelegramQuestionCallbackPrefix,
} from "./question-callback-data.js";

export type TelegramButtonStyle = "danger" | "success" | "primary";

export function normalizeTelegramButtonStyle(style: unknown): TelegramButtonStyle | undefined {
  return style === "danger" || style === "success" || style === "primary" ? style : undefined;
}

type TelegramInlineButton = {
  text: string;
  callback_data?: string;
  url?: string;
  web_app?: { url: string };
  style?: TelegramButtonStyle;
};

export type TelegramCallbackButton = Pick<TelegramInlineButton, "text" | "style"> & {
  callback_data: string;
};

export type TelegramInlineButtons = ReadonlyArray<ReadonlyArray<TelegramInlineButton>>;

export type TelegramDroppedControl = {
  label: string;
  reason:
    | "callback_data_too_long"
    | "invalid_action"
    | "question_context_unavailable"
    | "web_app_unavailable";
  callbackDataBytes?: number;
};

export type TelegramButtonBuildOptions = {
  allowWebAppButtons?: boolean;
  onDroppedControl?: (control: TelegramDroppedControl) => void;
  questionOptionIndices?: AskUserQuestionOptionIndices;
};

export function appendTelegramDroppedControlFallback(
  text: string,
  controls: readonly TelegramDroppedControl[],
): string {
  const fallback = renderMessagePresentationFallbackText({
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: controls.map((control) => ({ label: control.label, value: "unavailable" })),
        },
      ],
    },
  });
  if (!fallback || text === fallback || text.endsWith(`\n\n${fallback}`)) {
    return text;
  }
  return [text, fallback].filter(Boolean).join("\n\n");
}

const TELEGRAM_INTERACTIVE_ROW_SIZE = 3;

function recordDroppedControl(
  button: MessagePresentationButton,
  options: TelegramButtonBuildOptions | undefined,
  reason: Exclude<TelegramDroppedControl["reason"], "callback_data_too_long">,
  callbackData?: string,
): undefined {
  const callbackDataBytes = callbackData ? Buffer.byteLength(callbackData, "utf8") : undefined;
  options?.onDroppedControl?.({
    label: button.label,
    reason:
      callbackDataBytes !== undefined && callbackDataBytes > TELEGRAM_CALLBACK_DATA_MAX_BYTES
        ? "callback_data_too_long"
        : reason,
    ...(callbackDataBytes !== undefined ? { callbackDataBytes } : {}),
  });
  return undefined;
}

function toTelegramInlineButton(
  button: MessagePresentationButton,
  options?: TelegramButtonBuildOptions,
): TelegramInlineButton | undefined {
  const style = normalizeTelegramButtonStyle(button.style);
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return recordDroppedControl(button, options, "invalid_action");
  }
  if (action.type === "url") {
    return { text: button.label, url: action.url, style };
  }
  if (action.type === "web-app") {
    return options?.allowWebAppButtons === true && action.url
      ? { text: button.label, web_app: { url: action.url }, style }
      : recordDroppedControl(button, options, "web_app_unavailable");
  }
  const callbackButton = (
    data: string | undefined,
    reason: "invalid_action" | "question_context_unavailable" = "invalid_action",
    candidate?: string,
  ): TelegramInlineButton | undefined =>
    data
      ? { text: button.label, callback_data: data, style }
      : recordDroppedControl(button, options, reason, candidate);
  if (action.type === "approval") {
    return callbackButton(buildTelegramApprovalCallbackData(action));
  }
  if (action.type === "question") {
    const hasQuestionContext = options?.questionOptionIndices?.has(action.questionId) === true;
    if ("intent" in action) {
      const callbackData = hasQuestionContext
        ? buildTelegramQuestionCustomInputCallbackData(action.questionId)
        : undefined;
      return callbackButton(callbackData, "question_context_unavailable");
    }
    const optionIndex = resolveAskUserQuestionOptionIndex({
      questionOptionIndices: options?.questionOptionIndices,
      questionId: action.questionId,
      optionValue: action.optionValue,
    });
    if (optionIndex === undefined) {
      return recordDroppedControl(button, options, "question_context_unavailable");
    }
    // Presentation order is not authoritative; only Gateway-owned option order can choose an index.
    return callbackButton(
      buildTelegramQuestionCallbackData({ questionId: action.questionId, optionIndex }),
    );
  }
  if (action.type === "command") {
    const command = rewriteTelegramApprovalDecisionAlias(action.command.trim());
    const nativeCandidate = command ? buildTelegramNativeCommandCallbackData(command) : undefined;
    const nativeCallbackData = nativeCandidate
      ? sanitizeTelegramCallbackData(nativeCandidate)
      : undefined;
    // Historical approval commands may consume the full callback budget. Preserve
    // their authorized raw-command path when tgcmd: is the only overflow.
    const callbackData =
      nativeCallbackData ??
      (parseExecApprovalCommandText(command) ? sanitizeTelegramCallbackData(command) : undefined);
    return callbackButton(callbackData, "invalid_action", nativeCandidate);
  }
  // Reserve the full approval prefix, including malformed values, so legacy
  // plugin callbacks cannot be consumed by the approval handler.
  const normalizedCallbackValue = action.value.trim();
  const needsOpaqueEnvelope =
    Boolean(button.action) ||
    hasTelegramApprovalCallbackPrefix(normalizedCallbackValue) ||
    hasTelegramQuestionCallbackPrefix(normalizedCallbackValue);
  const callbackDataCandidate = needsOpaqueEnvelope
    ? buildTelegramOpaqueCallbackData(action.value)
    : action.value;
  return callbackButton(
    sanitizeTelegramCallbackData(callbackDataCandidate),
    "invalid_action",
    callbackDataCandidate,
  );
}

function chunkInteractiveButtons(
  buttons: readonly MessagePresentationButton[],
  rows: TelegramInlineButton[][],
  options?: TelegramButtonBuildOptions,
) {
  let row: TelegramInlineButton[] | undefined;
  for (const button of buttons) {
    const rendered = toTelegramInlineButton(button, options);
    if (!rendered) {
      continue;
    }
    const singleRow = resolveMessagePresentationButtonAction(button)?.type === "question";
    if (!row || row.length === TELEGRAM_INTERACTIVE_ROW_SIZE || singleRow) {
      row = [];
      rows.push(row);
    }
    row.push(rendered);
    if (singleRow) {
      row = undefined;
    }
  }
}

export function buildTelegramPresentationButtons(
  presentation?: MessagePresentation,
  options?: TelegramButtonBuildOptions,
): TelegramInlineButtons | undefined {
  const rows: TelegramInlineButton[][] = [];
  for (const block of presentation?.blocks ?? []) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      continue;
    }
    const buttons =
      block.type === "buttons"
        ? block.buttons
        : block.options.map((option) => ({
            label: option.label,
            action: option.action,
            value: option.value,
          }));
    chunkInteractiveButtons(buttons, rows, options);
  }
  return rows.length > 0 ? rows : undefined;
}

/** Resolve Telegram inline buttons, preserving explicit and legacy button precedence. */
export function resolveTelegramInlineButtons(
  params: {
    buttons?: TelegramInlineButtons;
    presentation?: unknown;
    interactive?: unknown;
  },
  options?: TelegramButtonBuildOptions,
): TelegramInlineButtons | undefined {
  if (params.buttons) {
    return params.buttons;
  }

  const interactive = normalizeLegacyInteractiveReply(params.interactive);
  return (
    buildTelegramPresentationButtons(
      interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined,
      options,
    ) ??
    buildTelegramPresentationButtons(normalizeMessagePresentation(params.presentation), options)
  );
}
export function resolveTelegramButtonsFromParams(
  params: Record<string, unknown>,
  presentation = normalizeMessagePresentation(params.presentation),
  options?: TelegramButtonBuildOptions,
) {
  return resolveTelegramInlineButtons(
    {
      presentation,
      interactive: params.interactive,
    },
    options,
  );
}
export function buildTelegramControlDegradation(
  controls: readonly TelegramDroppedControl[],
  fallbackDelivered: boolean,
) {
  if (controls.length === 0) {
    return undefined;
  }
  const reasons = [...new Set(controls.map((control) => control.reason))];
  const hasOverflow = reasons.includes("callback_data_too_long");
  return {
    warning: fallbackDelivered
      ? `Telegram delivered ${controls.length} unencodable control${controls.length === 1 ? "" : "s"} as readable text.`
      : `Telegram could not deliver ${controls.length} control${controls.length === 1 ? "" : "s"}.`,
    degradedDelivery: {
      droppedControls: controls.length,
      fallback: fallbackDelivered ? "text" : "not_delivered",
      reasons,
      ...(hasOverflow ? { callbackDataLimitBytes: TELEGRAM_CALLBACK_DATA_MAX_BYTES } : {}),
      guidance: hasOverflow
        ? `Shorten callback data to at most ${TELEGRAM_CALLBACK_DATA_MAX_BYTES} UTF-8 bytes and retry if clickable controls are required.`
        : "Retry with a supported control action if clickable controls are required.",
    },
  };
}
