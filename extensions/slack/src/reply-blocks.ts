import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndices,
  resolveSendableOutboundReplyParts,
  type AskUserQuestionOptionIndices,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackAuthoredTextPlacement,
  type SlackAuthoredTextPlacement,
} from "./authored-text.js";
import {
  buildSlackBlocksFallbackText,
  buildSlackCompleteBlocksFallbackText,
  renderSlackBlockFallbackText,
} from "./blocks-fallback.js";
import { parseSlackBlocksInput, SLACK_MAX_BLOCKS } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocksIfComplete,
  resolveSlackBlockOffsets,
  type SlackBlock,
  type SlackBlockRenderOptions,
} from "./blocks-render.js";
import { markdownToSlackMrkdwnChunks, type SlackMarkdownOptions } from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import {
  appendSlackNativeDataFallbackText,
  buildSlackNativeDataAccessibilityText,
  hasSlackNativeDataBlock,
} from "./native-data-blocks.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import { SLACK_BUTTON_ACTION_IDS, SLACK_SELECT_ACTION_IDS } from "./reply-action-ids.js";

export type SlackReplyBlockSegment =
  | { kind: "blocks"; blocks: SlackBlock[] }
  | { kind: "text"; text: string };

export type SlackReplyBlockResolution = {
  authoredTextPlacement: SlackAuthoredTextPlacement;
  segments: SlackReplyBlockSegment[];
};

export function normalizeSlackReplyPayload(payload: ReplyPayload): ReplyPayload {
  const previousSlackData = asOptionalRecord(payload.channelData?.slack) ?? {};
  const { authoredPresentationText: _authoredPresentationText, ...slackData } = previousSlackData;
  if (
    payload.presentationTextMode !== "fallback" ||
    !normalizeMessagePresentation(payload.presentation)
  ) {
    return Object.hasOwn(previousSlackData, "authoredPresentationText")
      ? { ...payload, channelData: { ...payload.channelData, slack: slackData } }
      : payload;
  }
  // Core withholds alternative text during native rendering. Capture it after
  // policy rewrites so the same Slack compiler can preserve authored literals.
  return {
    ...payload,
    channelData: {
      ...payload.channelData,
      slack: { ...slackData, authoredPresentationText: payload.text },
    },
  };
}

export type SlackReplyDeliveryMessage = {
  text: string;
  blocks?: SlackBlock[];
  authoredTextPlacement?: SlackAuthoredTextPlacement;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: true;
};

/** Project each segment only when the caller is ready to deliver it. */
export function* iterateSlackReplyDeliveryMessages(params: {
  authoredTextPlacement: SlackAuthoredTextPlacement;
  segments: readonly SlackReplyBlockSegment[];
  text?: string;
}): Iterable<SlackReplyDeliveryMessage> {
  let outsideText =
    params.authoredTextPlacement === "outside-blocks" ? (params.text?.trim() ?? "") : "";
  for (const segment of params.segments) {
    if (segment.kind === "text") {
      const text = [outsideText, segment.text].filter(Boolean).join("\n\n");
      outsideText = "";
      if (text) {
        yield { text, textIsSlackPlainText: true };
      }
      continue;
    }
    const baseText = outsideText;
    outsideText = "";
    const text =
      buildSlackNativeDataAccessibilityText(baseText, segment.blocks) ||
      buildSlackBlocksFallbackText(segment.blocks);
    const authoredTextPlacement: SlackAuthoredTextPlacement = baseText
      ? "outside-blocks"
      : params.authoredTextPlacement === "blocks"
        ? "blocks"
        : "none";
    yield {
      text,
      blocks: segment.blocks,
      authoredTextPlacement,
      ...(baseText ? { nativeDataFallbackBaseText: baseText } : {}),
    };
  }
  if (outsideText) {
    yield { text: outsideText, authoredTextPlacement: "outside-blocks" };
  }
}

export function resolveSlackReplyDeliveryMessages(
  params: Parameters<typeof iterateSlackReplyDeliveryMessages>[0],
): SlackReplyDeliveryMessage[] {
  return Array.from(iterateSlackReplyDeliveryMessages(params));
}

type SlackReplyRenderPlan =
  | {
      mode: "single";
      text: string;
      blocks?: SlackBlock[];
      textIsSlackMrkdwn?: boolean;
      textIsSlackPlainText?: true;
    }
  | {
      mode: "split";
      fallbackText: string;
      blockPart?: { text: string; blocks?: SlackBlock[] };
    };

export function resolveSlackReplyRenderPlan(
  payload: ReplyPayload,
  text = payload.text,
  options: SlackMarkdownOptions = {},
): SlackReplyRenderPlan {
  return prepareSlackReply(payload, options).resolvePreview(text);
}

export type PreparedSlackReply = {
  readonly payload: ReplyPayload;
  resolveDelivery: () => SlackReplyBlockResolution;
  resolvePreview: (text?: string) => SlackReplyRenderPlan;
};

/** One attempt owns its authored compilation; media captions retain a separate delivery policy. */
export function prepareSlackReply(
  payload: ReplyPayload,
  options: SlackMarkdownOptions = {},
): PreparedSlackReply {
  const text = payload.text;
  let authoredChunks: readonly string[] | undefined;
  let structuredContent: boolean | undefined;
  let materialized: SlackReplyBlockResolution | undefined;
  let unmaterialized: SlackReplyBlockResolution | undefined;
  let preview: SlackReplyRenderPlan | undefined;
  const resolveAuthoredTextChunks = () =>
    (authoredChunks ??= markdownToSlackMrkdwnChunks(
      text?.trim() ?? "",
      SLACK_SECTION_TEXT_MAX,
      options,
    ));
  const hasStructuredContent = () =>
    (structuredContent ??= hasSlackReplyStructuredContent(payload));
  const resolve = (materializeAuthoredText: boolean) =>
    materializeAuthoredText
      ? (materialized ??= resolveSlackReplyBlockResolution(payload, {
          ...options,
          materializeAuthoredText: true,
          resolveAuthoredTextChunks,
        }))
      : (unmaterialized ??= resolveSlackReplyBlockResolution(payload, {
          ...options,
          resolveAuthoredTextChunks,
        }));
  return {
    payload,
    resolveDelivery: () =>
      resolve(!resolveSendableOutboundReplyParts(payload).hasMedia && hasStructuredContent()),
    resolvePreview: (override = text) => {
      if (override !== text) {
        return prepareSlackReply({ ...payload, text: override }, options).resolvePreview();
      }
      return (preview ??= projectSlackReplyRenderPlan(
        text,
        resolve(hasStructuredContent()),
        resolveAuthoredTextChunks,
      ));
    },
  };
}

function projectSlackReplyRenderPlan(
  text: string | undefined,
  resolution: SlackReplyBlockResolution,
  resolveAuthoredTextChunks: () => readonly string[],
): SlackReplyRenderPlan {
  const messages = resolveSlackReplyDeliveryMessages({
    authoredTextPlacement: resolution.authoredTextPlacement,
    segments: resolution.segments,
    text,
  });
  if (messages.length <= 1) {
    const [message] = messages;
    const sourceText = resolution.authoredTextPlacement === "none" ? "" : (text?.trim() ?? "");
    const blocks =
      message?.authoredTextPlacement === "blocks"
        ? addPreviewVerbatimToAuthoredTextBlocks(
            message.blocks,
            sourceText ? resolveAuthoredTextChunks() : [],
          )
        : message?.blocks;
    // Previews use mrkdwn; escape literal block labels at that boundary.
    let renderedText = message?.blocks
      ? buildSlackCompleteBlocksFallbackText(message.blocks, { includeSelectOptions: true })
      : (message?.text ?? text ?? "");
    let textIsSlackMrkdwn = Boolean(
      message &&
      !message.textIsSlackPlainText &&
      (message.authoredTextPlacement !== "outside-blocks" || message.nativeDataFallbackBaseText),
    );
    if (blocks?.length && sourceText) {
      if (hasSlackNativeDataBlock(blocks)) {
        renderedText = appendSlackNativeDataFallbackText(sourceText, blocks) || renderedText;
        textIsSlackMrkdwn = true;
      } else if (message?.authoredTextPlacement === "blocks") {
        renderedText = sourceText;
        textIsSlackMrkdwn = false;
      }
    }
    return {
      mode: "single",
      text: renderedText,
      ...(blocks ? { blocks } : {}),
      ...(textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
      ...(message?.textIsSlackPlainText ? { textIsSlackPlainText: true } : {}),
    };
  }
  const blockPart = messages.find((message) => message.blocks?.length);
  return {
    mode: "split",
    fallbackText: messages
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n"),
    ...(blockPart ? { blockPart: { text: blockPart.text, blocks: blockPart.blocks } } : {}),
  };
}

function readSlackChannelBlocks(payload: ReplyPayload): SlackBlock[] {
  return parseSlackBlocksInput(asOptionalRecord(payload.channelData?.slack)?.blocks) ?? [];
}

export function hasSlackReplyStructuredContent(payload: ReplyPayload): boolean {
  return Boolean(
    readSlackChannelBlocks(payload).length ||
    normalizeMessagePresentation(payload.presentation) ||
    payload.interactive?.blocks.length,
  );
}

function literalSlackComparisonText(text: string): string | null {
  // Literal Block Kit fields cannot represent mrkdwn emphasis or code.
  return /[*_~`]/u.test(text) ? null : escapeSlackMrkdwn(text);
}

function renderSlackRichTextComparisonFragments(value: unknown): (string | null)[] {
  if (!Array.isArray(value)) {
    return [null];
  }
  return value.map((raw): string | null => {
    const section = asOptionalRecord(raw);
    if (
      (section?.type !== "rich_text_section" && section?.type !== "rich_text_preformatted") ||
      !Array.isArray(section.elements)
    ) {
      return null;
    }
    let text = "";
    let style: string | undefined;
    for (const rawElement of section.elements) {
      const element = asOptionalRecord(rawElement);
      if (element?.type !== "text" || typeof element.text !== "string") {
        return null;
      }
      const styles = Object.entries(asOptionalRecord(element.style) ?? {}).filter(
        ([, enabled]) => enabled !== false,
      );
      const nextStyle = styles[0]?.[0] ?? "";
      if (
        styles.length > 1 ||
        styles.some(
          ([key, enabled]) =>
            enabled !== true || !["bold", "italic", "strike", "code"].includes(key),
        ) ||
        (style !== undefined && nextStyle !== style)
      ) {
        return null;
      }
      style = nextStyle;
      text += element.text;
    }
    if (section.type === "rich_text_preformatted") {
      return style || text.includes("```")
        ? null
        : "```\n" + escapeSlackMrkdwn(text) + (text.endsWith("\n") ? "" : "\n") + "```";
    }
    if (style === "code") {
      return /[`\r\n]/u.test(text) ? null : "`" + escapeSlackMrkdwn(text) + "`";
    }
    const literal = literalSlackComparisonText(text);
    if (!style || literal === null) {
      return literal;
    }
    if (text.trim() !== text) {
      return null;
    }
    const marker = style === "bold" ? "*" : style === "italic" ? "_" : "~";
    return marker + literal + marker;
  });
}

function renderSlackAuthoredTextFragments(blocks: readonly SlackBlock[]): (string | null)[] {
  const readTextObject = (value: unknown): string | null | undefined => {
    const record = asOptionalRecord(value);
    const text = normalizeOptionalString(record?.text);
    return text === undefined
      ? undefined
      : record?.type === "mrkdwn"
        ? text
        : literalSlackComparisonText(text);
  };
  return blocks.flatMap((block): (string | null)[] => {
    const record = asOptionalRecord(block);
    if (block.type === "actions" || block.type === "divider") {
      return [];
    }
    if (block.type === "section" || block.type === "context" || block.type === "header") {
      const objects =
        block.type === "context"
          ? Array.isArray(record?.elements)
            ? record.elements
            : []
          : [record?.text, ...(Array.isArray(record?.fields) ? record.fields : [])];
      return objects.map(readTextObject).filter((text) => text !== undefined);
    }
    if (block.type === "rich_text") {
      return renderSlackRichTextComparisonFragments(record?.elements);
    }
    const text = renderSlackBlockFallbackText(block);
    return text ? [/[*_~`]/u.test(text) ? null : text] : [];
  });
}

function buildSlackAuthoredTextBlocks(chunks: readonly string[]): SlackBlock[] {
  return chunks.map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk, verbatim: true },
  }));
}

function addPreviewVerbatimToAuthoredTextBlocks(
  blocks: SlackBlock[] | undefined,
  authoredTextChunks: readonly string[],
): SlackBlock[] | undefined {
  if (!blocks?.length || authoredTextChunks.length === 0) {
    return blocks;
  }
  const authoredChunks = new Set(authoredTextChunks);
  return blocks.map((block) => {
    const text = (block as { text?: { text?: unknown; type?: unknown; verbatim?: unknown } }).text;
    if (
      block.type !== "section" ||
      text?.type !== "mrkdwn" ||
      typeof text.text !== "string" ||
      !authoredChunks.has(text.text)
    ) {
      return block;
    }
    return {
      ...block,
      text: { ...text, verbatim: true },
    } as SlackBlock;
  });
}

function readLastBlockSegment(segments: SlackReplyBlockSegment[]): SlackBlock[] {
  const last = segments.at(-1);
  return last?.kind === "blocks" ? last.blocks : [];
}

function readAllNativeBlocks(segments: SlackReplyBlockSegment[]): SlackBlock[] {
  return segments.flatMap((segment) => (segment.kind === "blocks" ? segment.blocks : []));
}

function appendTextSegment(segments: SlackReplyBlockSegment[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const last = segments.at(-1);
  if (last?.kind === "text") {
    last.text = `${last.text}\n\n${trimmed}`;
    return;
  }
  segments.push({ kind: "text", text: trimmed });
}

function appendBlockSegment(
  segments: SlackReplyBlockSegment[],
  blocks: SlackBlock[],
  startNew = false,
): void {
  let shouldStartNew = startNew;
  for (const block of blocks) {
    const last = segments.at(-1);
    if (!shouldStartNew && last?.kind === "blocks" && last.blocks.length < SLACK_MAX_BLOCKS) {
      last.blocks.push(block);
    } else {
      segments.push({ kind: "blocks", blocks: [block] });
    }
    shouldStartNew = false;
  }
}

function resolvePresentationRenderOptions(
  segments: SlackReplyBlockSegment[],
  mode: "current" | "new-message",
): SlackBlockRenderOptions {
  const allOffsets = resolveSlackBlockOffsets(readAllNativeBlocks(segments), "controls");
  const messageOffsets =
    mode === "current" ? resolveSlackBlockOffsets(readLastBlockSegment(segments)) : {};
  // Control ids span the logical reply, while chart/table limits reset for
  // each Slack message. Sharing one offset would needlessly discard native data.
  return {
    ...messageOffsets,
    buttonIndexOffset: allOffsets.buttonIndexOffset,
    selectIndexOffset: allOffsets.selectIndexOffset,
  };
}

function appendPresentationPart(
  segments: SlackReplyBlockSegment[],
  presentation: MessagePresentation,
  questionOptionIndices?: AskUserQuestionOptionIndices,
): void {
  const currentBlocks = readLastBlockSegment(segments);
  for (const mode of ["current", "new-message"] as const) {
    const rendered = buildSlackPresentationBlocksIfComplete(presentation, {
      ...resolvePresentationRenderOptions(segments, mode),
      questionOptionIndices,
    });
    const startNew = mode === "new-message";
    if (
      rendered?.length &&
      (startNew || currentBlocks.length + rendered.length <= SLACK_MAX_BLOCKS)
    ) {
      appendBlockSegment(segments, rendered, startNew);
      return;
    }
  }

  appendTextSegment(
    segments,
    // The caller sends fallback segments with mrkdwn disabled, so preserve
    // authored tokens and command bytes instead of emitting visible entities.
    renderMessagePresentationFallbackText({ presentation }),
  );
}

const SLACK_BUTTON_CONTROL_ACTION_IDS = Object.values(SLACK_BUTTON_ACTION_IDS);
const SLACK_SELECT_CONTROL_ACTION_IDS = Object.values(SLACK_SELECT_ACTION_IDS);

function readGeneratedSlackControlRowKey(block: SlackBlock): string | undefined {
  const record = block as { block_id?: unknown; elements?: unknown; type?: unknown };
  if (record.type !== "actions" || typeof record.block_id !== "string") {
    return undefined;
  }
  const expectedElementType = /^openclaw_reply_buttons_[1-9]\d*$/.test(record.block_id)
    ? "button"
    : /^openclaw_reply_select_[1-9]\d*$/.test(record.block_id)
      ? "static_select"
      : undefined;
  if (!expectedElementType || !Array.isArray(record.elements) || record.elements.length === 0) {
    return undefined;
  }
  const actionIds =
    expectedElementType === "button"
      ? SLACK_BUTTON_CONTROL_ACTION_IDS
      : SLACK_SELECT_CONTROL_ACTION_IDS;
  const elements = record.elements.map((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      return undefined;
    }
    const { action_id: actionId, ...content } = element as Record<string, unknown>;
    const actionFamily =
      typeof actionId === "string"
        ? actionIds.find((candidate) => actionId.startsWith(`${candidate}:`))
        : undefined;
    return actionFamily && content.type === expectedElementType
      ? [actionFamily, content]
      : undefined;
  });
  return elements.some((element) => element === undefined) ? undefined : JSON.stringify(elements);
}

function subtractMirroredSlackControlRows(params: {
  interactiveBlocks: readonly SlackBlock[];
  presentationBlocks: readonly SlackBlock[];
}): SlackBlock[] {
  const remainingMirrors = new Map<string, number>();
  for (const block of params.presentationBlocks) {
    const key = readGeneratedSlackControlRowKey(block);
    if (key) {
      remainingMirrors.set(key, (remainingMirrors.get(key) ?? 0) + 1);
    }
  }
  return params.interactiveBlocks.filter((block) => {
    const key = readGeneratedSlackControlRowKey(block);
    const remaining = key ? (remainingMirrors.get(key) ?? 0) : 0;
    if (!key || remaining === 0) {
      return true;
    }
    remainingMirrors.set(key, remaining - 1);
    return false;
  });
}

function compileSlackReplyBlockSegments(
  payload: ReplyPayload,
  channelBlocks: SlackBlock[],
  presentation: ReturnType<typeof normalizeMessagePresentation>,
): SlackReplyBlockSegment[] {
  const segments: SlackReplyBlockSegment[] = [];
  const textIsFallback = presentation && payload.presentationTextMode === "fallback";
  if (channelBlocks.length > 0) {
    appendBlockSegment(segments, channelBlocks);
  }

  const questionOptionIndices = resolveAskUserQuestionOptionIndices(payload);
  const presentationBlockOffset = readAllNativeBlocks(segments).length;
  if (presentation?.title) {
    appendPresentationPart(
      segments,
      { title: presentation.title, blocks: [] },
      questionOptionIndices,
    );
  }
  for (const block of presentation?.blocks ?? []) {
    appendPresentationPart(segments, { blocks: [block] }, questionOptionIndices);
  }
  const renderedPresentationBlocks = readAllNativeBlocks(segments).slice(presentationBlockOffset);

  const interactiveBlocks = payload.interactive
    ? buildSlackInteractiveBlocks(payload.interactive, {
        ...resolveSlackBlockOffsets(readAllNativeBlocks(segments)),
        questionOptionIndices,
      })
    : [];
  // Companions are independent of the presentation's alternative text.
  // Preserve the authored continuation when no native presentation survives.
  if (
    textIsFallback &&
    payload.text?.trim() &&
    renderedPresentationBlocks.every(
      (block) =>
        ["header", "section", "context", "divider", "rich_text"].includes(block.type) &&
        !("accessory" in block && block.accessory),
    )
  ) {
    segments.length = 0;
    appendBlockSegment(segments, channelBlocks);
    appendTextSegment(segments, payload.text);
  }
  // Compare final Slack rows, not source payloads: fallbacks and transport
  // limits can prevent an apparent source mirror from rendering at all.
  appendBlockSegment(
    segments,
    subtractMirroredSlackControlRows({
      interactiveBlocks,
      presentationBlocks: renderedPresentationBlocks,
    }),
  );
  return segments;
}

/**
 * Resolve reply content into transport-order segments. Each blocks segment is
 * one Slack message; text segments carry complete fallback content between it.
 */
export function resolveSlackReplyBlockResolution(
  payload: ReplyPayload,
  options: SlackMarkdownOptions & {
    materializeAuthoredText?: boolean;
    resolveAuthoredTextChunks?: () => readonly string[];
  } = {},
): SlackReplyBlockResolution {
  const presentation = normalizeMessagePresentation(payload.presentation);
  const authoredText =
    presentation && payload.presentationTextMode === "fallback"
      ? undefined
      : normalizeOptionalString(payload.text);
  const channelBlocks = readSlackChannelBlocks(payload);
  let segments = compileSlackReplyBlockSegments(payload, channelBlocks, presentation);
  const chunks =
    authoredText && (segments.length > 0 || options.materializeAuthoredText)
      ? (options.resolveAuthoredTextChunks?.() ??
        markdownToSlackMrkdwnChunks(authoredText, SLACK_SECTION_TEXT_MAX, options))
      : [];
  let authoredTextPlacement = resolveSlackAuthoredTextPlacement({
    text: authoredText,
    authoredChunks: chunks,
    renderedTextFragments: segments.flatMap((segment) =>
      segment.kind === "text"
        ? [literalSlackComparisonText(segment.text)]
        : renderSlackAuthoredTextFragments(segment.blocks),
    ),
  });
  if (authoredTextPlacement === "outside-blocks" && !/[*_~`<[\]\\#>|]/u.test(authoredText ?? "")) {
    // Plain fallbacks and chart/table summaries retain source list markers.
    // Compare their exact bytes too, without treating literal markup as styling.
    authoredTextPlacement = resolveSlackAuthoredTextPlacement({
      text: authoredText,
      renderedTextFragments: segments.flatMap((segment) =>
        segment.kind === "text"
          ? [segment.text]
          : segment.blocks.map((block) =>
              hasSlackNativeDataBlock([block])
                ? (renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" }) ?? null)
                : null,
            ),
      ),
    });
  }
  if (options.materializeAuthoredText && authoredTextPlacement === "outside-blocks") {
    // Decide from the final rendered content, then use the same packing owner
    // to insert only missing prose after raw blocks and before the presentation.
    segments = compileSlackReplyBlockSegments(
      payload,
      [...channelBlocks, ...buildSlackAuthoredTextBlocks(chunks)],
      presentation,
    );
    authoredTextPlacement = "blocks";
  }
  return { authoredTextPlacement, segments };
}

/** Return the single-message native shape when no ordered text fallback is required. */
export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  const segments = compileSlackReplyBlockSegments(
    payload,
    readSlackChannelBlocks(payload),
    normalizeMessagePresentation(payload.presentation),
  );
  return segments.length === 1 && segments[0]?.kind === "blocks" ? segments[0].blocks : undefined;
}
