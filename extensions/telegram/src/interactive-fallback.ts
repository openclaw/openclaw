import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentation,
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
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
  type TelegramDroppedControl,
} from "./button-types.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";

const TELEGRAM_CONTROL_ONLY_FALLBACK = "Choose an option.";

const TELEGRAM_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
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
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

// The `<table>` HTML island feeds the existing island -> rich-block converter,
// which emits native Bot API 10.3 table blocks (bordered, striped, native
// caption, header cells) on rich accounts. Markdown pipe tables cannot express
// row-header columns or native captions, so the island form is canonical here.
function renderTelegramTableIsland(block: MessagePresentationTableBlock): string {
  const caption = block.caption.trim()
    ? `<caption>${escapeTelegramTableCellText(block.caption)}</caption>`
    : "";
  const headerRow = block.headers
    .map((header) => `<th>${escapeTelegramTableCellText(header)}</th>`)
    .join("");
  const bodyRows = block.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) =>
            index === block.rowHeaderColumnIndex
              ? `<th>${escapeTelegramTableCellText(cell)}</th>`
              : `<td>${escapeTelegramTableCellText(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table>${caption}<thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

// Context blocks are low-emphasis by contract; italics is Telegram's closest
// native register. Lines already containing markdown emphasis markers stay
// plain so wrapping cannot mis-parse them.
function renderTelegramContextText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
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
function canEncodeTelegramPresentationControl(
  block: MessagePresentationInteractiveBlock,
  options?: TelegramButtonBuildOptions,
): boolean {
  return Boolean(buildTelegramPresentationButtons({ blocks: [block] }, options)?.length);
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
  for (const block of params.presentation.blocks) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      fallbackBlocks.push(block);
      continue;
    }
    if (!params.presentationControlsSelected) {
      fallbackBlocks.push(block);
      continue;
    }
    if (block.type === "buttons") {
      const nativeButtons: typeof block.buttons = [];
      const fallbackButtons: typeof block.buttons = [];
      for (const button of block.buttons) {
        const target = canEncodeTelegramPresentationControl(
          { type: "buttons", buttons: [button] },
          params.buttonOptions,
        )
          ? nativeButtons
          : fallbackButtons;
        target.push(button);
      }
      if (nativeButtons.length > 0) {
        nativeControlBlocks.push({ type: "buttons", buttons: nativeButtons });
      }
      if (fallbackButtons.length > 0) {
        fallbackBlocks.push({ type: "buttons", buttons: fallbackButtons });
      }
      continue;
    }

    const nativeOptions: typeof block.options = [];
    const fallbackOptions: typeof block.options = [];
    for (const option of block.options) {
      const target = canEncodeTelegramPresentationControl(
        { type: "select", options: [option] },
        params.buttonOptions,
      )
        ? nativeOptions
        : fallbackOptions;
      target.push(option);
    }
    if (nativeOptions.length > 0) {
      nativeControlBlocks.push({ ...block, options: nativeOptions });
    }
    if (fallbackOptions.length > 0) {
      fallbackBlocks.push({ ...block, options: fallbackOptions });
    } else if (block.placeholder) {
      // Telegram maps selects to buttons, so retain the select prompt in message text.
      fallbackBlocks.push({ type: "text", text: block.placeholder });
    }
  }
  return { fallbackBlocks, nativeControlBlocks };
}

/** Convert portable presentation into the one Telegram payload shape used by every send funnel. */
export function canonicalizeTelegramPresentationPayload(
  payload: ReplyPayload,
  options?: { allowWebAppButtons?: boolean; richTables?: boolean },
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
  const richTables = options?.richTables === true;
  const presentation = adaptMessagePresentationForChannel({
    presentation: normalizedPresentation,
    capabilities: resolveTelegramPresentationCapabilities({ richMessages: richTables }),
  });

  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: options?.allowWebAppButtons === true,
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
        limits: {
          actions: { maxLabelLength: 64 },
          selects: { maxLabelLength: 64 },
        },
      },
    }),
    buttonOptions,
  );
  const buttons = existingButtons ?? presentationButtons;

  const fallbackText = richTables
    ? renderTelegramRichFallbackText({ ...presentation, blocks: fallbackBlocks })
    : renderMessagePresentationFallbackText({
        presentation: { ...presentation, blocks: fallbackBlocks },
      });
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
    text: text || (buttons ? TELEGRAM_CONTROL_ONLY_FALLBACK : ""),
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
