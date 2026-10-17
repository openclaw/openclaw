import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveLegacyInteractiveTextFallback,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationButton,
  type MessagePresentationInteractiveBlock,
  type MessagePresentationTableBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  copyReplyPayloadMetadata,
  resolveAskUserQuestionOptionIndices,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  appendTelegramDroppedControlFallback,
  buildTelegramPresentationButtons,
  escapeTelegramCopyTextFallback,
  isValidTelegramCopyText,
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
  type TelegramDroppedControl,
} from "./button-types.js";
import { escapeTelegramHtml } from "./format-html.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";

const TELEGRAM_CONTROL_ONLY_FALLBACK = "Choose an option.";

const TELEGRAM_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  copyTextButtons: true,
  selects: true,
  context: true,
  divider: false,
  // Native table blocks require the account's Bot API 10.3 rich-message path;
  // per-account capability resolution flips this on when richMessages is enabled.
  tables: false,
  limits: {
    actions: {
      maxActions: 100,
      maxActionsPerRow: 3,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 100,
      optionsConsumeActionBudget: true,
    },
    text: {
      markdownDialect: "markdown" as const,
    },
  },
};

export function resolveTelegramPresentationCapabilities(params: {
  richMessages: boolean;
}): typeof TELEGRAM_PRESENTATION_CAPABILITIES {
  return params.richMessages
    ? { ...TELEGRAM_PRESENTATION_CAPABILITIES, tables: true }
    : TELEGRAM_PRESENTATION_CAPABILITIES;
}

function escapeTelegramTableCellText(value: string | number): string {
  return escapeTelegramHtml(String(value)).replace(/\s+/g, " ").trim();
}

// The `<table>` HTML island feeds the existing island -> rich-block converter,
// which emits native Bot API 10.3 table blocks (bordered, striped, native
// caption, header cells) on rich accounts. Markdown pipe tables cannot express
// row-header columns or native captions, so the island form is canonical here.
function renderTelegramTableIsland(block: MessagePresentationTableBlock): string {
  const caption = block.caption.trim()
    ? `<caption>${escapeTelegramTableCellText(block.caption)}</caption>`
    : "";
  const renderRow = (cells: readonly (string | number)[], header: "all" | number | undefined) =>
    `<tr>${cells
      .map((cell, index) => {
        const tag = header === "all" || index === header ? "th" : "td";
        return `<${tag}>${escapeTelegramTableCellText(cell)}</${tag}>`;
      })
      .join("")}</tr>`;
  const headerRow = renderRow(block.headers, "all");
  const bodyRows = block.rows.map((row) => renderRow(row, block.rowHeaderColumnIndex)).join("");
  return `<table>${caption}<thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`;
}

// Context blocks are low-emphasis by contract; italics is Telegram's closest
// native register. Lines already containing markdown emphasis markers stay
// plain so wrapping cannot mis-parse them. Fenced literals retain every byte:
// shared action-budget fallback uses fences for multiline copy-text values.
function renderTelegramContextText(text: string): string {
  let fenceMarker: string | undefined;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      const marker = /^(`{3,}|~{3,})$/u.exec(trimmed)?.[1];
      if (marker) {
        if (!fenceMarker) {
          fenceMarker = marker;
        } else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
          fenceMarker = undefined;
        }
        return line;
      }
      if (fenceMarker) {
        return line;
      }
      return trimmed && !/[_*]/.test(trimmed) ? `_${trimmed}_` : line;
    })
    .join("\n");
}

function renderTelegramRichFallbackText(presentation: MessagePresentation): string {
  const parts: string[] = [];
  if (presentation.title?.trim()) {
    parts.push(`**${presentation.title.trim()}**`);
  }
  for (const block of presentation.blocks) {
    const text =
      block.type === "table"
        ? renderTelegramTableIsland(block)
        : block.type === "context"
          ? renderTelegramContextText(block.text)
          : renderMessagePresentationFallbackText({ presentation: { blocks: [block] } });
    if (text.trim()) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

const telegramDroppedControlFallbacks = new WeakMap<object, string>();
export function markTelegramDroppedControlFallback(
  payload: ReplyPayload,
  textBefore: string,
  textAfter: string,
): ReplyPayload {
  if (textBefore !== textAfter) {
    telegramDroppedControlFallbacks.set(payload, textAfter.slice(textBefore.length));
  }
  return payload;
}
export function copyTelegramDroppedControlFallback<T extends ReplyPayload | undefined>(
  source: ReplyPayload,
  payload: T,
): T {
  const fallback = telegramDroppedControlFallbacks.get(source);
  if (payload && fallback) {
    telegramDroppedControlFallbacks.set(payload, fallback);
  }
  return payload;
}
export const applyTextToPayload = (payload: ReplyPayload, text: string): ReplyPayload =>
  payload.text === text
    ? payload
    : copyTelegramDroppedControlFallback(
        payload,
        copyReplyPayloadMetadata(payload, { ...payload, text }),
      );

function canEncodeTelegramPresentationControl(
  block: MessagePresentationInteractiveBlock,
  options?: TelegramButtonBuildOptions,
): boolean {
  return Boolean(buildTelegramPresentationButtons({ blocks: [block] }, options)?.length);
}

function prepareTelegramCopyTextFallbackButton(
  button: MessagePresentationButton,
): MessagePresentationButton {
  const action = resolveMessagePresentationButtonAction(button);
  if (action?.type !== "copy-text" || isValidTelegramCopyText(action.text)) {
    return button;
  }
  return {
    ...button,
    action: { type: "copy-text", text: escapeTelegramCopyTextFallback(action.text) },
  };
}

function renderTelegramControlFallbackText(block: MessagePresentationInteractiveBlock): string {
  const fallbackBlock =
    block.type === "buttons"
      ? { ...block, buttons: block.buttons.map(prepareTelegramCopyTextFallbackButton) }
      : block;
  return renderMessagePresentationFallbackText({ presentation: { blocks: [fallbackBlock] } });
}

function prepareTelegramControlFallbackBlock(block: MessagePresentationInteractiveBlock) {
  const text = renderTelegramControlFallbackText(block);
  const containsCopyText =
    block.type === "buttons" &&
    block.buttons.some(
      (button) => resolveMessagePresentationButtonAction(button)?.type === "copy-text",
    );
  return containsCopyText ? { type: "text" as const, text } : { type: "context" as const, text };
}

/** Remove Telegram-invalid copy actions before core spends the shared action budget. */
export function prepareTelegramPresentationPayloadForCoreAdaptation(
  payload: ReplyPayload,
): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  let changed = false;
  const blocks = presentation.blocks.flatMap((block): MessagePresentation["blocks"] => {
    if (block.type !== "buttons") {
      return [block];
    }
    const nativeButtons: typeof block.buttons = [];
    const fallbackButtons: typeof block.buttons = [];
    for (const button of block.buttons) {
      const action = resolveMessagePresentationButtonAction(button);
      const target =
        action?.type === "copy-text" && !isValidTelegramCopyText(action.text)
          ? fallbackButtons
          : nativeButtons;
      target.push(button);
    }
    if (fallbackButtons.length === 0) {
      return [block];
    }
    changed = true;
    return [
      ...(nativeButtons.length > 0 ? [{ ...block, buttons: nativeButtons }] : []),
      prepareTelegramControlFallbackBlock({ type: "buttons", buttons: fallbackButtons }),
    ];
  });
  return changed ? { ...payload, presentation: { ...presentation, blocks } } : payload;
}

function prepareTelegramPresentationForAdaptation(params: {
  presentation: MessagePresentation;
  presentationControlsSelected: boolean;
  buttonOptions: TelegramButtonBuildOptions;
}): MessagePresentation {
  if (!params.presentationControlsSelected) {
    return params.presentation;
  }
  const blocks = params.presentation.blocks.flatMap((block): MessagePresentation["blocks"] => {
    if (!isMessagePresentationInteractiveBlock(block)) {
      return [block];
    }
    if (block.type === "buttons") {
      const nativeButtons = block.buttons.filter((button) =>
        canEncodeTelegramPresentationControl(
          { type: "buttons", buttons: [button] },
          params.buttonOptions,
        ),
      );
      const native = new Set(nativeButtons);
      const fallbackButtons = block.buttons.filter((button) => !native.has(button));
      return [
        ...(nativeButtons.length > 0 ? [{ type: "buttons" as const, buttons: nativeButtons }] : []),
        ...(fallbackButtons.length > 0
          ? [prepareTelegramControlFallbackBlock({ type: "buttons", buttons: fallbackButtons })]
          : []),
      ];
    }

    const nativeOptions = block.options.filter((option) =>
      canEncodeTelegramPresentationControl(
        { type: "select", options: [option] },
        params.buttonOptions,
      ),
    );
    const native = new Set(nativeOptions);
    const fallbackOptions = block.options.filter((option) => !native.has(option));
    return [
      ...(nativeOptions.length > 0
        ? [
            {
              ...block,
              options: nativeOptions,
              ...(fallbackOptions.length > 0 ? { placeholder: undefined } : {}),
            },
          ]
        : []),
      ...(fallbackOptions.length > 0
        ? [prepareTelegramControlFallbackBlock({ ...block, options: fallbackOptions })]
        : []),
    ];
  });
  return { ...params.presentation, blocks };
}

function partitionTelegramPresentationBlocks(params: {
  presentation: MessagePresentation;
  presentationControlsSelected: boolean;
  buttonOptions: TelegramButtonBuildOptions;
}): {
  fallbackBlocks: MessagePresentation["blocks"];
  nativeControlBlocks: MessagePresentationInteractiveBlock[];
} {
  const fallbackBlocks: MessagePresentation["blocks"] = [];
  const nativeControlBlocks: MessagePresentationInteractiveBlock[] = [];
  const partitionControls = <T>(
    controls: readonly T[],
    blockFor: (controls: T[]) => MessagePresentationInteractiveBlock,
  ): boolean => {
    const native: T[] = [];
    const fallback: T[] = [];
    for (const control of controls) {
      const buttons = buildTelegramPresentationButtons(
        { blocks: [blockFor([control])] },
        params.buttonOptions,
      );
      (buttons?.length ? native : fallback).push(control);
    }
    if (native.length > 0) {
      nativeControlBlocks.push(blockFor(native));
    }
    if (fallback.length > 0) {
      fallbackBlocks.push(prepareTelegramControlFallbackBlock(blockFor(fallback)));
    }
    return fallback.length > 0;
  };
  for (const block of params.presentation.blocks) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      fallbackBlocks.push(block);
      continue;
    }
    if (!params.presentationControlsSelected) {
      // An existing provider/legacy keyboard owns the native action budget. Render
      // portable controls through Telegram's fallback sanitizer so invalid copy
      // values stay inspectable instead of being rewritten by TDLib semantics.
      fallbackBlocks.push(prepareTelegramControlFallbackBlock(block));
      continue;
    }
    if (block.type === "buttons") {
      partitionControls(block.buttons, (buttons) => ({ type: "buttons", buttons }));
    } else if (
      !partitionControls(block.options, (options) => ({ ...block, options })) &&
      block.placeholder
    ) {
      // Telegram maps selects to buttons, so retain the select prompt in message text.
      fallbackBlocks.push({ type: "text", text: block.placeholder });
    }
  }
  return { fallbackBlocks, nativeControlBlocks };
}

/** Convert portable presentation into the one Telegram payload shape used by every send funnel. */
export function canonicalizeTelegramPresentationPayload(
  payload: ReplyPayload,
  options?: {
    allowWebAppButtons?: boolean;
    onDroppedControl?: TelegramButtonBuildOptions["onDroppedControl"];
    preserveEmptyTextForControls?: boolean;
    richTables?: boolean;
  },
): ReplyPayload {
  const normalizedPresentation = normalizeMessagePresentation(payload.presentation);
  const telegramData = payload.channelData?.telegram as
    | (Record<string, unknown> & {
        buttons?: Parameters<typeof resolveTelegramInlineButtons>[0]["buttons"];
      })
    | undefined;
  if (!normalizedPresentation) {
    const nativeButtons = resolveTelegramInlineButtons({ buttons: telegramData?.buttons });
    if (!buildInlineKeyboard(nativeButtons) || payload.text?.trim()) {
      return payload;
    }
    // Native-only controls need the same visible message anchor as portable controls.
    return copyReplyPayloadMetadata(payload, { ...payload, text: TELEGRAM_CONTROL_ONLY_FALLBACK });
  }
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: options?.allowWebAppButtons === true,
    onDroppedControl: options?.onDroppedControl,
    questionOptionIndices: resolveAskUserQuestionOptionIndices(payload),
  };
  const existingButtons = resolveTelegramInlineButtons(
    {
      buttons: telegramData?.buttons,
      interactive,
    },
    buttonOptions,
  );
  const presentationControlsSelected = existingButtons === undefined;
  const richTables = options?.richTables === true;
  const presentation = adaptMessagePresentationForChannel({
    presentation: prepareTelegramPresentationForAdaptation({
      presentation: normalizedPresentation,
      presentationControlsSelected,
      buttonOptions,
    }),
    capabilities: resolveTelegramPresentationCapabilities({ richMessages: richTables }),
  });
  const { fallbackBlocks, nativeControlBlocks } = partitionTelegramPresentationBlocks({
    presentation,
    presentationControlsSelected,
    buttonOptions,
  });
  // Only native labels are clipped; unavailable controls retain their full text.
  const presentationButtons = buildTelegramPresentationButtons(
    adaptMessagePresentationForChannel({
      presentation: { blocks: nativeControlBlocks },
      capabilities: {
        copyTextButtons: true,
        limits: {
          actions: { maxLabelLength: 64 },
          selects: { maxLabelLength: 64 },
        },
      },
    }),
    buttonOptions,
  );
  const buttons = existingButtons ?? presentationButtons;

  const fallbackPresentation = { ...presentation, blocks: fallbackBlocks };
  const fallbackText = richTables
    ? renderTelegramRichFallbackText(fallbackPresentation)
    : renderMessagePresentationFallbackText({ presentation: fallbackPresentation });
  const currentText =
    resolveLegacyInteractiveTextFallback({ text: payload.text, interactive })?.trim() ?? "";
  const textIsFallback = payload.presentationTextMode === "fallback";
  const hasFallback =
    fallbackText.length > 0 &&
    (currentText === fallbackText || currentText.endsWith(`\n\n${fallbackText}`));
  // Native controls replace their choice text, including control-only replies.
  // Text-only delivery keeps the producer's complete authored fallback.
  const text = textIsFallback
    ? nativeControlBlocks.length > 0
      ? fallbackText
      : richTables
        ? fallbackText || currentText
        : currentText || fallbackText
    : hasFallback
      ? currentText
      : [currentText, fallbackText].filter(Boolean).join("\n\n");
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    ...withoutPresentation
  } = payload;
  const canonical: ReplyPayload = {
    ...withoutPresentation,
    text:
      text ||
      (buttons && !(options?.preserveEmptyTextForControls === true && payload.text === "")
        ? TELEGRAM_CONTROL_ONLY_FALLBACK
        : ""),
  };
  if (buttons) {
    canonical.channelData = {
      ...payload.channelData,
      telegram: {
        ...telegramData,
        buttons,
      },
    };
  }
  return copyReplyPayloadMetadata(payload, canonical);
}

export function resolveTelegramInteractiveTextFallback(params: {
  text?: string | null;
  interactive?: unknown;
  presentation?: unknown;
}): string | undefined {
  const interactive = normalizeLegacyInteractiveReply(params.interactive);
  const text = resolveLegacyInteractiveTextFallback({
    text: params.text ?? undefined,
    interactive,
  });
  if (text?.trim()) {
    return text;
  }
  const presentation = normalizeMessagePresentation(params.presentation);
  if (presentation) {
    const fallback = renderMessagePresentationFallbackText({
      text: params.text ?? undefined,
      presentation,
    });
    if (fallback.trim()) {
      return fallback;
    }
  }
  if (!interactive) {
    return text;
  }
  const interactivePresentation = legacyInteractiveReplyToPresentation(interactive);
  if (!interactivePresentation) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation: interactivePresentation });
  return fallback.trim() ? fallback : text;
}
export function resolveFinalTelegramPresentationText(params: {
  payload: ReplyPayload;
  text: string;
  richMessages: boolean;
  allowWebAppButtons?: boolean;
}): string | undefined {
  // Rich rendering is opt-in. Preserve the authored plain fallback when the
  // account cannot encode native presentation blocks.
  if (!params.richMessages) {
    return undefined;
  }
  const presentation = normalizeMessagePresentation(params.payload.presentation);
  if (!presentation) {
    return undefined;
  }
  const droppedControls: TelegramDroppedControl[] = [];
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: params.allowWebAppButtons === true,
    questionOptionIndices: resolveAskUserQuestionOptionIndices(params.payload),
  };
  // SAFETY: untyped channelData buttons are only forwarded for resolver precedence; this path never reads their entries.
  const telegramData = params.payload.channelData?.telegram as
    | { buttons?: Parameters<typeof resolveTelegramInlineButtons>[0]["buttons"] }
    | undefined;
  resolveTelegramInlineButtons(
    {
      buttons: telegramData?.buttons,
      interactive: normalizeLegacyInteractiveReply(params.payload.interactive),
    },
    { ...buttonOptions, onDroppedControl: (control) => droppedControls.push(control) },
  );
  const suffix = telegramDroppedControlFallbacks.get(params.payload);
  const canonicalText =
    suffix && params.text.endsWith(suffix) ? params.text.slice(0, -suffix.length) : params.text;
  const canonicalInputText =
    suffix && params.payload.presentationTextMode !== "fallback"
      ? appendTelegramDroppedControlFallback(canonicalText, droppedControls)
      : canonicalText;
  const rendered = canonicalizeTelegramPresentationPayload(
    { ...params.payload, text: canonicalInputText },
    { richTables: true, allowWebAppButtons: params.allowWebAppButtons },
  ).text?.trimEnd();
  if (!rendered) {
    return undefined;
  }
  const finalText =
    params.payload.presentationTextMode === "fallback"
      ? appendTelegramDroppedControlFallback(rendered, droppedControls)
      : rendered;
  return finalText !== params.text.trimEnd() ? finalText : undefined;
}
