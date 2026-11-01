import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderPresentationForDelivery,
  renderMessagePresentationFallbackText,
  renderMessagePresentationTableFallbackText,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentationBlock,
  type MessagePresentationButton,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import type { OutboundIdentity, ReplyPayload } from "../runtime-api.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import {
  feishuCardWithinTableLimit,
  hasCardMarkdownTable,
  hasUndrawableCardTable,
  literalizeFeishuCardTables,
  shouldUseCard,
  withinCardTableLimit,
} from "./card-table-shapes.js";
import { parseFeishuCommentTarget } from "./comment-target.js";
import { resolveFeishuIdentityHeaderTitle } from "./identity-header.js";
import { fencesSurvive } from "./markdown.js";
import type { MentionTarget } from "./mention-target.types.js";
import { buildMentionedCardContent } from "./mention.js";
import {
  escapeFeishuCardMarkdownText,
  escapeFeishuCardPlainText,
  resolveSafeFeishuButtonUrl,
  resolveFeishuButtonType,
  readNativeFeishuCardJson,
  sanitizeNativeFeishuCard,
  type FeishuNativeCard,
} from "./native-card.js";
import { cutKeepingTables, fitBlockParts } from "./presentation-table-parts.js";

type NormalizedMessagePresentation = NonNullable<ReturnType<typeof normalizeMessagePresentation>>;
type FeishuPresentationTextFormat = "plain" | "markdown";
const RENDERED_FEISHU_CARD = Symbol("openclaw.renderedFeishuCard");
const FEISHU_PRESENTATION_FALLBACK_MARKER = "__openclawPresentationFallback";

export const FEISHU_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: true,
  divider: true,
  limits: {
    actions: {
      maxActions: 20,
      maxActionsPerRow: 5,
      maxLabelLength: 40,
      maxValueBytes: 1024,
    },
    text: {
      maxLength: 4000,
      encoding: "characters",
      markdownDialect: "markdown",
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

const FEISHU_CARD_TEXT_MAX_LENGTH = FEISHU_PRESENTATION_CAPABILITIES.limits.text.maxLength;
const FEISHU_CARD_GREY_OPEN = "<font color='grey'>";
const FEISHU_CARD_GREY_CLOSE = "</font>";
const FEISHU_CARD_GREY_LENGTH = FEISHU_CARD_GREY_OPEN.length + FEISHU_CARD_GREY_CLOSE.length;

function projectBlockText(
  text: string,
  renderText: (text: string) => string,
  reserve = 0,
  encodeText: (text: string) => string = escapeFeishuCardMarkdownText,
  keepTables = true,
): string[] {
  const ceiling = FEISHU_CARD_TEXT_MAX_LENGTH - reserve;
  const rendered = renderText(text);
  if (encodeText(rendered).length + reserve <= FEISHU_CARD_TEXT_MAX_LENGTH) {
    return [rendered];
  }
  // A card draws a native table as one component, so a cut through it leaves its rows in later
  // elements with no header, as raw pipes. An ordinary card takes the post path for that, which a
  // presentation cannot take without losing its controls. A table that fits one element is kept
  // whole instead, and a longer one is cut into fenced pieces that each repeat its header. A
  // table the card cannot draw is a list, as on every other card path. `off` asks for the
  // authored pipes, which it keeps, and so does a card that only fits cut that way.
  const cut = (piece: string) => fitBlockParts(piece, ceiling, encodeText);
  const parts = !keepTables
    ? cut(rendered)
    : cutKeepingTables(
        hasUndrawableCardTable(rendered) ? convertMarkdownTables(rendered, "bullets") : rendered,
        (piece) => encodeText(piece).length <= ceiling,
        cut,
      );
  // A quote prefix hides a fence marker from the chunker's scanner, so a quoted table
  // long enough to need several elements leaves its opening fence in one and its closing
  // fence in another, and neither draws a block. The send paths answer this the same way:
  // a conversion the cut cannot carry gives way to the authored text, which is the form
  // the shared adapter would have cut anyway.
  // A post draws the authored rows, but a card draws nothing at all for a table under a
  // quote or a list marker, so handing them back here would lose them where the projection
  // had only made them unreadable. The conversion has already hidden that table inside a
  // fence by the time the element renderer asks, so this is the one place left that can see
  // it. A list survives the container and the cut alike, which is the shape every other card
  // path degrades an undrawable table to.
  if (rendered !== text && parts.length > 0 && !fencesSurvive(rendered, parts)) {
    const drawable = hasUndrawableCardTable(text) ? convertMarkdownTables(text, "bullets") : text;
    const authored = fitBlockParts(drawable, ceiling, encodeText);
    if (authored.length > 0) {
      return authored;
    }
  }
  return parts.length ? parts : [rendered];
}

const FEISHU_CARD_MAX_BYTES = 30 * 1024;
const FEISHU_CARD_MAX_ELEMENTS = 200;

export function resolveFeishuRichReply(payload: { interactive?: unknown; presentation?: unknown }) {
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  return {
    interactive,
    presentation:
      normalizeMessagePresentation(payload.presentation) ??
      (interactive ? legacyInteractiveReplyToPresentation(interactive) : undefined),
  };
}

export function buildFeishuPresentationFallback(params: {
  text?: string;
  presentation?: NormalizedMessagePresentation;
  fallbackHasCommand?: boolean;
  textFormat?: FeishuPresentationTextFormat;
}) {
  const fallbackText = renderFeishuPresentationFallbackText(params, params.textFormat);
  // Only warn when the rendered fallback exposes a command the user can copy.
  const fallbackHasCommand =
    params.fallbackHasCommand === true ||
    params.presentation?.blocks.some((block) =>
      block.type === "select"
        ? block.options.some(({ action }) => action?.type === "command")
        : block.type === "buttons" &&
          block.buttons.some(({ action, disabled }) => !disabled && action?.type === "command"),
    ) === true;
  return {
    fallbackText,
    fallbackHasCommand,
    commentText: fallbackHasCommand
      ? `${fallbackText}\n\n> Interactive buttons are unavailable in Feishu document comments. You can type the command shown above manually.`
      : fallbackText,
  };
}

function countFeishuCardElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((count, entry) => count + countFeishuCardElements(entry), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }
  let count = typeof value.tag === "string" ? 1 : 0;
  for (const entry of Object.values(value)) {
    count += countFeishuCardElements(entry);
    if (count > FEISHU_CARD_MAX_ELEMENTS) {
      break;
    }
  }
  return count;
}

export function isFeishuCardWithinEnvelope(card: Record<string, unknown>): boolean {
  try {
    return (
      Buffer.byteLength(JSON.stringify(card), "utf8") <= FEISHU_CARD_MAX_BYTES &&
      countFeishuCardElements(card) <= FEISHU_CARD_MAX_ELEMENTS
    );
  } catch {
    return false;
  }
}

export function assertFeishuCardWithinEnvelope(card: Record<string, unknown>): void {
  if (!isFeishuCardWithinEnvelope(card)) {
    throw new Error("Feishu native card exceeds the 30 KB or 200-element API limit.");
  }
}

/**
 * A card carries a table as one component, and the card chunker cuts on lines without
 * repeating the header and its delimiter, so every card after the first shows those rows
 * as raw pipes. A table that does not fit one card belongs on the post path, which renders
 * it as a fenced block that survives the cut. One rule, asked at every place that promotes
 * text to a card.
 */
export function cardCarriesWholeTable(
  text: string,
  chunk: (text: string) => readonly string[],
): boolean {
  const chunks = chunk(text);
  if (hasCardMarkdownTable(text) && chunks.length > 1) {
    return false;
  }
  // A conversion has already hidden its table inside a fence by the time this asks, so the
  // question the cards still have to answer is the fence one: the card chunker cannot close
  // and reopen a quoted marker any more than the post chunker can.
  return fencesSurvive(text, [...chunks]);
}

function resolveFeishuButtonUrl(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "url" || button.action?.type === "web-app") {
    return button.action.url;
  }
  if (button.action) {
    return undefined;
  }
  return button.url ?? button.webApp?.url ?? button.web_app?.url;
}

function resolveFeishuCommandButtonValue(button: MessagePresentationButton): string | undefined {
  if (button.action?.type === "command") {
    return button.action.command;
  }
  if (button.action) {
    return undefined;
  }
  return button.value;
}

export function renderFeishuPresentationFallbackText(
  params: Parameters<typeof renderMessagePresentationFallbackText>[0],
  textFormat: FeishuPresentationTextFormat = "plain",
): string {
  const presentation = params.presentation;
  return renderMessagePresentationFallbackText({
    ...params,
    presentation: presentation && {
      ...presentation,
      blocks: presentation.blocks.map((block) =>
        block.type === "buttons"
          ? {
              type: block.type,
              buttons: block.buttons.map((button) => {
                const url = resolveFeishuButtonUrl(button);
                // Reject the same targets everywhere; only Markdown transports escape labels.
                return {
                  ...button,
                  ...(textFormat === "markdown"
                    ? { label: escapeFeishuCardPlainText(button.label) }
                    : {}),
                  ...(url && !resolveSafeFeishuButtonUrl(url) ? { disabled: true } : {}),
                };
              }),
            }
          : block,
      ),
    },
  });
}

function buildFeishuPayloadButton(button: MessagePresentationButton): Record<string, unknown> {
  const url = resolveSafeFeishuButtonUrl(resolveFeishuButtonUrl(button));
  const value = resolveFeishuCommandButtonValue(button);
  if (button.disabled || (!url && !value)) {
    // Keep each unavailable control visible without exposing rejected URLs or opaque values.
    return { tag: "markdown", content: `- ${escapeFeishuCardPlainText(button.label)}` };
  }
  const behaviors: Record<string, unknown>[] = [];
  if (url) {
    behaviors.push({ type: "open_url", default_url: url });
  }
  if (value) {
    behaviors.push({
      type: "callback",
      value: createFeishuCardInteractionEnvelope({
        k: "quick",
        a: "feishu.payload.button",
        q: value,
      }),
    });
  }
  return {
    tag: "button",
    text: { tag: "plain_text", content: button.label },
    type: resolveFeishuButtonType(button.style),
    behaviors,
  };
}

function buildFeishuCardElementsForBlock(
  block: MessagePresentationBlock,
  renderText: (text: string) => string,
  encodeText: (text: string) => string,
  keepTables: boolean,
): Record<string, unknown>[] {
  if (block.type === "text") {
    return projectBlockText(block.text, renderText, 0, encodeText, keepTables).map((part) => ({
      tag: "markdown",
      content: encodeText(part),
    }));
  }
  if (block.type === "context") {
    // `code` mode hands this block a fenced table, and a fence only opens and closes
    // at the start of its own line. Inside the color tag those markers stop being
    // fences and the rows arrive as literal text, so a context block carrying one
    // keeps its shape and gives up the grey.
    // The colour tag is added after the split, so its own characters come out of the
    // budget the parts are sized to. A part carrying a fence gives the tag up and could
    // have had them back, which costs a little room rather than an oversized element.
    return projectBlockText(
      block.text,
      renderText,
      FEISHU_CARD_GREY_LENGTH,
      encodeText,
      keepTables,
    ).map((part) => {
      const content = encodeText(part);
      return {
        tag: "markdown",
        content: /```[\s\S]*?```/.test(content)
          ? content
          : `${FEISHU_CARD_GREY_OPEN}${content}${FEISHU_CARD_GREY_CLOSE}`,
      };
    });
  }
  if (block.type === "divider") {
    return [{ tag: "hr" }];
  }
  if (block.type === "buttons") {
    return block.buttons.map(buildFeishuPayloadButton);
  }
  if (block.type === "chart") {
    return [
      {
        tag: "markdown",
        content: encodeText(renderText(renderMessagePresentationChartFallbackText(block))),
      },
    ];
  }
  if (block.type === "table") {
    // A table block carries as many rows as the producer had, and its linear form is one
    // element unless it is cut, so it takes the same projection a text block does.
    return projectBlockText(
      renderMessagePresentationTableFallbackText(block),
      renderText,
      0,
      encodeText,
    ).map((part) => ({
      tag: "markdown",
      content: encodeText(part),
    }));
  }
  return [
    {
      tag: "markdown",
      content: encodeText(
        renderText(renderMessagePresentationFallbackText({ presentation: { blocks: [block] } })),
      ),
    },
  ];
}

function resolvePresentationHeaderTemplate(tone: NormalizedMessagePresentation["tone"]) {
  if (tone === "danger") {
    return "red";
  }
  if (tone === "warning") {
    return "orange";
  }
  if (tone === "success") {
    return "green";
  }
  return "blue";
}

function buildFeishuPresentationCardElements(params: {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
  renderText?: (text: string) => string;
  tableMode?: MarkdownTableMode;
  rawTableCut?: boolean;
}): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];
  const keepTables = params.tableMode !== "off" && !params.rawTableCut;
  const renderText = params.renderText ?? ((text: string) => text);
  const encodeText =
    params.tableMode === "off"
      ? (text: string) => literalizeFeishuCardTables(text, escapeFeishuCardMarkdownText)
      : escapeFeishuCardMarkdownText;
  const fallbackText = params.fallbackText?.trim();
  if (fallbackText) {
    // The fallback is projected like any block and outgrows the limit the same way.
    for (const part of projectBlockText(fallbackText, renderText, 0, encodeText, keepTables)) {
      elements.push({ tag: "markdown", content: encodeText(part) });
    }
  }
  for (const block of params.presentation.blocks) {
    elements.push(...buildFeishuCardElementsForBlock(block, renderText, encodeText, keepTables));
  }
  if (elements.length > 0) {
    return elements;
  }
  return [{ tag: "markdown", content: "" }];
}

/**
 * A card does not draw a table inside a quote or a list item, so those rows leave the message
 * rather than degrade, which is why the reply path sends those shapes as a post instead. A
 * presentation cannot take that route without losing its controls, so its elements take the
 * fallback the streamed preview takes and the rows survive as a list. The prose a fallback
 * carries is left alone, since a post draws what a card cannot.
 *
 * `off` is the exception: it asks for the authored pipes rather than for a card-safe shape,
 * and a list is a shape. Off-mode card encoding escapes delimiter punctuation instead.
 * Every other mode either converts the rows itself, which leaves this
 * nothing to replace, or draws them natively and only needs the shapes the card refuses. An
 * unstated mode is not `off`, so it keeps the substitution.
 */
function cardElementRenderer(
  renderText?: (text: string) => string,
  tableMode?: MarkdownTableMode,
): ((text: string) => string) | undefined {
  if (!renderText) {
    return undefined;
  }
  return (text: string) => {
    const rendered = renderText(text);
    return tableMode !== "off" && hasUndrawableCardTable(rendered)
      ? convertMarkdownTables(rendered, "bullets")
      : rendered;
  };
}

type FeishuPresentationCardParams = {
  presentation: NormalizedMessagePresentation;
  fallbackText?: string;
  renderText?: (text: string) => string;
  tableMode?: MarkdownTableMode;
  rawTableCut?: boolean;
};

const cardAdmitted = (card: Record<string, unknown>) =>
  isFeishuCardWithinEnvelope(card) && feishuCardWithinTableLimit(card);

/**
 * The card that can be delivered. The split-safe cut repeats headers the raw cut does not, so when
 * only the raw cut is admitted that is the card, and the split-safe card is kept whenever it is
 * admitted. A caller that names a cut gets that cut, because it weighs what the card carries
 * besides this (the mentions) and asks again.
 */
export function buildFeishuPresentationCard(
  params: FeishuPresentationCardParams,
): FeishuNativeCard {
  const card = buildPresentationCardOnce(params);
  if (params.rawTableCut !== undefined || params.tableMode === "off" || cardAdmitted(card)) {
    return card;
  }
  const raw = buildPresentationCardOnce({ ...params, rawTableCut: true });
  return cardAdmitted(raw) ? raw : card;
}

function buildPresentationCardOnce(params: FeishuPresentationCardParams): FeishuNativeCard {
  const elementParams = {
    ...params,
    ...(params.renderText
      ? { renderText: cardElementRenderer(params.renderText, params.tableMode) }
      : {}),
  };
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
    },
    ...(params.presentation.title
      ? {
          header: {
            title: { tag: "plain_text", content: params.presentation.title },
            template: resolvePresentationHeaderTemplate(params.presentation.tone),
          },
        }
      : {}),
    body: {
      elements: buildFeishuPresentationCardElements(elementParams),
    },
  };
}

export function markRenderedFeishuCard(card: FeishuNativeCard): FeishuNativeCard {
  Object.defineProperty(card, RENDERED_FEISHU_CARD, {
    value: true,
    enumerable: false,
  });
  return card;
}

export function readNativeFeishuCard(payload: { channelData?: Record<string, unknown> }) {
  const feishuData = payload.channelData?.feishu;
  if (!isRecord(feishuData)) {
    return undefined;
  }
  const card = feishuData.card ?? feishuData.interactiveCard;
  if (!isRecord(card)) {
    return undefined;
  }
  const rendered = card as FeishuNativeCard & { [RENDERED_FEISHU_CARD]?: true };
  if (rendered[RENDERED_FEISHU_CARD] === true) {
    return rendered;
  }
  const sanitizedCard = sanitizeNativeFeishuCard(card);
  return sanitizedCard ? markRenderedFeishuCard(sanitizedCard) : undefined;
}

export function consumeFeishuPresentationFallbackMarker(payload: ReplyPayload): {
  payload: ReplyPayload;
  presentationFallback?: { hasVisibleContent: boolean; authoredText?: string };
} {
  const feishuData = isRecord(payload.channelData?.feishu) ? payload.channelData.feishu : undefined;
  const presentationFallback = feishuData?.[FEISHU_PRESENTATION_FALLBACK_MARKER];
  if (
    !isRecord(presentationFallback) ||
    typeof presentationFallback.hasVisibleContent !== "boolean"
  ) {
    return { payload };
  }
  const nextFeishuData = { ...feishuData };
  delete nextFeishuData[FEISHU_PRESENTATION_FALLBACK_MARKER];
  const nextChannelData = { ...payload.channelData };
  if (Object.keys(nextFeishuData).length > 0) {
    nextChannelData.feishu = nextFeishuData;
  } else {
    delete nextChannelData.feishu;
  }
  return {
    payload: {
      ...payload,
      channelData: Object.keys(nextChannelData).length > 0 ? nextChannelData : undefined,
    },
    presentationFallback: {
      hasVisibleContent: presentationFallback.hasVisibleContent,
      ...(typeof presentationFallback.authoredText === "string"
        ? { authoredText: presentationFallback.authoredText }
        : {}),
    },
  };
}

type FeishuPayloadCardParams = {
  payload: ReplyPayload;
  text?: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
  renderText?: (text: string) => string;
  tableMode?: MarkdownTableMode;
};

/**
 * Whether a card is delivered is decided for the whole card, with its header, mentions and
 * controls, so that is where the split-safe cut of a table is weighed. Its repeated headers
 * add bytes the raw cut does not, and a card the raw cut delivered keeps its controls: the raw
 * cut is built when only that one is admitted. The split-safe card is kept whenever it is.
 */
export function buildFeishuPayloadCard(params: FeishuPayloadCardParams) {
  return buildAdmittedPayloadCard(params, false) ?? buildAdmittedPayloadCard(params, true);
}

function buildAdmittedPayloadCard(
  params: FeishuPayloadCardParams,
  rawTableCut: boolean,
): FeishuNativeCard | undefined {
  const nativeCard = readNativeFeishuCard(params.payload);
  const rawText = params.text ?? params.payload.text;
  const textCard = readNativeFeishuCardJson(rawText);
  const { interactive, presentation } = resolveFeishuRichReply(params.payload);
  let card = nativeCard ?? (!presentation ? textCard : undefined);
  const isNativeCard = card !== undefined;
  if (!card && presentation) {
    card = buildFeishuPresentationCard({
      renderText: params.renderText,
      tableMode: params.tableMode,
      rawTableCut,
      presentation: {
        ...presentation,
        title: presentation.title ?? resolveFeishuIdentityHeaderTitle(params.identity),
      },
      fallbackText: textCard
        ? undefined
        : resolveLegacyInteractiveTextFallback({ text: rawText, interactive }),
    });
  }
  if (!card) {
    return undefined;
  }
  if (params.mentions?.length) {
    // Ingress owns these recipients. Add their markup after sanitizing model-authored
    // content, and include it in the final native envelope budget.
    card = {
      ...card,
      body: {
        ...card.body,
        elements: [
          { tag: "markdown", content: buildMentionedCardContent(params.mentions, "").trimEnd() },
          ...card.body.elements,
        ],
      },
    };
  }
  if (isNativeCard) {
    assertFeishuCardWithinEnvelope(card);
    return markRenderedFeishuCard(card);
  }
  return cardAdmitted(card) ? markRenderedFeishuCard(card) : undefined;
}

type FeishuPresentationContext = {
  to: string;
  identity?: OutboundIdentity;
  mentions?: MentionTarget[];
  renderText?: (text: string) => string;
  tableMode?: MarkdownTableMode;
};

export function renderFeishuPresentationPayload({
  payload,
  presentation,
  sourcePresentation,
  ctx,
}: {
  payload: ReplyPayload;
  presentation: NormalizedMessagePresentation;
  sourcePresentation?: NormalizedMessagePresentation;
  ctx: FeishuPresentationContext;
}) {
  const cardFor = (candidate: ReplyPayload) =>
    buildFeishuPayloadCard({
      payload: candidate,
      text: payload.text,
      identity: ctx.identity,
      mentions: ctx.mentions,
      renderText: ctx.renderText,
      tableMode: ctx.tableMode,
    });
  // Core cut the blocks before this ran, so a card refused here has no raw cut left to try. The
  // authored source still has one, and it is the cut a card was delivered with before.
  const rawCut =
    sourcePresentation && ctx.renderText
      ? projectPresentationForDelivery({
          presentation,
          sourcePresentation,
          renderText: ctx.renderText,
          tableMode: ctx.tableMode,
          rawTableCut: true,
        })
      : presentation;
  const card =
    cardFor(payload) ??
    (rawCut === presentation ? undefined : cardFor({ ...payload, presentation: rawCut }));
  const isComment = Boolean(parseFeishuCommentTarget(ctx.to));
  // Native limits may clip labels. A whole-card or comment fallback must retain
  // the authored labels; an accepted native card keeps its adapted projection.
  const fallbackPresentation =
    !card || isComment ? (sourcePresentation ?? presentation) : presentation;
  const { fallbackText: rawFallbackText, fallbackHasCommand } = buildFeishuPresentationFallback({
    text: readNativeFeishuCardJson(payload.text) ? undefined : payload.text,
    presentation: fallbackPresentation,
    textFormat: isComment ? "plain" : "markdown",
  });
  // Card elements and the fallback are separate projections of authored prose.
  // Neither projection consumes text already formatted for the other.
  // A comment carries no card, and the comment sender converts for its own chunker and
  // keeps the authored form when the markers would not survive the cut. Converting here
  // first would hand it a conversion it cannot undo, so the authored prose goes through.
  const fallbackText =
    ctx.renderText && !isComment ? ctx.renderText(rawFallbackText) : rawFallbackText;
  const existingFeishuData = isRecord(payload.channelData?.feishu)
    ? payload.channelData.feishu
    : undefined;
  // Core consumes presentation before sendPayload. A fallback retains its own
  // visible contribution separately from prose already delivered by streaming.
  return {
    ...payload,
    text: fallbackText,
    channelData: {
      ...payload.channelData,
      feishu: {
        ...existingFeishuData,
        ...(card
          ? { card }
          : {
              [FEISHU_PRESENTATION_FALLBACK_MARKER]: {
                hasVisibleContent: Boolean(
                  renderFeishuPresentationFallbackText({
                    presentation: fallbackPresentation,
                  }).trim(),
                ),
                // The prose this payload carries is a conversion of the presentation, and a cut
                // that cannot carry its fences has to fall back to something. The top-level text
                // is only part of it, so the whole of it travels with the payload, whichever
                // form the conversion took: a mode that converts nothing still contributed the
                // blocks, and falling back to the payload's own text would drop them.
                authoredText: rawFallbackText,
              },
            }),
        ...(fallbackHasCommand ? { fallbackHasCommand: true } : {}),
      },
    },
  };
}

/**
 * The shared adapter cuts an oversized block to the text limit before the plugin renders
 * anything, and that cut lands on the authored table, so every fragment after the first
 * starts on a data row and no longer parses as a table at all. Projecting here, and
 * cutting the projected form with the chunker that closes and reopens a fence, hands the
 * adapter blocks that already fit and that it therefore leaves alone.
 */
function projectPresentationBlocks(
  presentation: NormalizedMessagePresentation,
  renderText: (text: string) => string,
  keepTables: boolean,
): NormalizedMessagePresentation {
  const blocks: MessagePresentationBlock[] = [];
  for (const block of presentation.blocks) {
    if (block.type !== "text" && block.type !== "context") {
      blocks.push(block);
      continue;
    }
    const reserve = block.type === "context" ? FEISHU_CARD_GREY_LENGTH : 0;
    const parts = projectBlockText(block.text, renderText, reserve, undefined, keepTables);
    if (parts.length <= 1 && parts[0] === block.text) {
      blocks.push(block);
      continue;
    }
    for (const text of parts) {
      blocks.push({ ...block, text });
    }
  }
  return { ...presentation, blocks };
}

/**
 * Core adapts a presentation to this channel's limits before the plugin renders anything, and
 * the registered outbound path reaches the renderer with that cut already made. Projecting the
 * source and adapting the projection hands the same adapter blocks that already fit, so it
 * leaves them whole. A projection that changes nothing leaves core's own adaptation standing.
 */
export function projectPresentationForDelivery(params: {
  presentation: NormalizedMessagePresentation;
  sourcePresentation?: NormalizedMessagePresentation;
  renderText?: (text: string) => string;
  tableMode?: MarkdownTableMode;
  rawTableCut?: boolean;
}): NormalizedMessagePresentation {
  const { presentation, sourcePresentation, renderText } = params;
  if (!renderText || !sourcePresentation) {
    return presentation;
  }
  const keepTables = params.tableMode !== "off" && !params.rawTableCut;
  const projected = projectPresentationBlocks(sourcePresentation, renderText, keepTables);
  const unchanged =
    projected.blocks.length === sourcePresentation.blocks.length &&
    projected.blocks.every((block, index) => block === sourcePresentation.blocks[index]);
  if (unchanged) {
    return presentation;
  }
  return (
    normalizeMessagePresentation(
      adaptMessagePresentationForChannel({
        presentation: projected,
        capabilities: FEISHU_PRESENTATION_CAPABILITIES,
      }),
    ) ?? presentation
  );
}

export async function renderFeishuReplyPayload(
  payload: ReplyPayload,
  ctx: FeishuPresentationContext,
): Promise<{ payload: ReplyPayload; card?: FeishuNativeCard }> {
  const { presentation } = resolveFeishuRichReply(payload);
  if (!presentation) {
    return {
      payload:
        payload.text && ctx.renderText
          ? { ...payload, text: ctx.renderText(payload.text) }
          : payload,
    };
  }
  const rendered = await renderPresentationForDelivery(
    {
      presentationCapabilities: FEISHU_PRESENTATION_CAPABILITIES,
      // The projection below is what the shared renderer receives, so the presentation it
      // hands back as the source is that projection and not the authored one. A fallback
      // built from it would be a conversion of itself, and the payload would then travel
      // with no authored form for a cut that cannot carry the conversion to fall back to.
      // The authored presentation is still here, so it goes through directly.
      renderPresentation: (adapted) =>
        renderFeishuPresentationPayload({
          payload: adapted,
          presentation: adapted.presentation,
          sourcePresentation: presentation,
          ctx,
        }),
    },
    {
      ...payload,
      presentation: ctx.renderText
        ? projectPresentationBlocks(presentation, ctx.renderText, ctx.tableMode !== "off")
        : presentation,
    },
  );
  // Legacy controls have now been consumed too; a fallback must not render them again.
  const { interactive: _interactive, ...withoutInteractive } = rendered;
  return { payload: withoutInteractive, card: readNativeFeishuCard(withoutInteractive) };
}

export {
  feishuCardWithinTableLimit,
  hasCardMarkdownTable,
  hasUndrawableCardTable,
  shouldUseCard,
  withinCardTableLimit,
};
