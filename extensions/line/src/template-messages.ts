// Line plugin module implements template messages behavior.
import type { messagingApi } from "@line/bot-sdk";
import {
  messageAction,
  normalizeLineAction,
  postbackAction,
  uriAction,
  type Action,
} from "./actions.js";
import type { LineTemplateMessagePayload } from "./types.js";

type TemplateMessage = messagingApi.TemplateMessage;
type TextMessage = messagingApi.TextMessage;
type ConfirmTemplate = messagingApi.ConfirmTemplate;
type ButtonsTemplate = messagingApi.ButtonsTemplate;
type CarouselTemplate = messagingApi.CarouselTemplate;
type CarouselColumn = messagingApi.CarouselColumn;

const COMPACT_TEMPLATE_TEXT_LIMIT = 60;
const TEMPLATE_ALT_TEXT_LIMIT = 1500;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

type TemplatePayloadAction = {
  type?: "uri" | "postback" | "message";
  uri?: string;
  data?: string;
  label: string;
};

function buildTemplatePayloadAction(action: TemplatePayloadAction): Action {
  if (action.type === "uri" && action.uri) {
    return uriAction(action.label, action.uri);
  }
  if (action.type === "postback" && action.data) {
    return postbackAction(action.label, action.data, action.label);
  }
  // Empty data means "tap sends the label": a message action with empty text
  // makes LINE reject the whole message. Whitespace-only data is accepted by
  // LINE and echoed verbatim on tap, so it must stay untouched.
  const data = action.data === "" ? undefined : action.data;
  return messageAction(action.label, data ?? action.label);
}

function resolveTemplateTextLimit(params: {
  title?: string;
  thumbnailImageUrl?: string;
  textOnlyLimit: number;
}): number {
  return params.title !== undefined || params.thumbnailImageUrl !== undefined
    ? COMPACT_TEMPLATE_TEXT_LIMIT
    : params.textOnlyLimit;
}

function truncateTemplateText(text: string, limit: number): string {
  let result = "";
  for (const { segment } of graphemeSegmenter.segment(text)) {
    if (result.length + segment.length > limit) {
      // A pathological grapheme can exceed LINE's whole field limit. Preserve
      // graphemes normally, but keep required text non-empty without splitting
      // a surrogate pair when the first grapheme alone cannot fit.
      if (!result) {
        for (const codePoint of segment) {
          if (result.length + codePoint.length > limit) {
            break;
          }
          result += codePoint;
        }
      }
      break;
    }
    result += segment;
  }
  return result;
}

function truncateOptionalTemplateText(
  value: string | undefined,
  limit: number,
): string | undefined {
  return value === undefined ? undefined : truncateTemplateText(value, limit);
}

function resolveTemplateAltText(value: string | undefined, fallback: string): string {
  return truncateTemplateText(value ?? fallback, TEMPLATE_ALT_TEXT_LIMIT);
}

function normalizeCarouselColumnActions(column: CarouselColumn): CarouselColumn {
  return {
    ...column,
    actions: column.actions.map((action) => normalizeLineAction(action)),
    defaultAction:
      column.defaultAction === undefined ? undefined : normalizeLineAction(column.defaultAction),
  };
}

// Template buttons render their label; LINE rejects the whole message when a
// template action's label is empty.
function hasRenderableLabel(action: Action): boolean {
  return Boolean(action.label);
}

// LINE rejects the whole carousel unless every column carries non-blank text,
// keeps at least one labeled action, and title, thumbnail, and action count
// usage match across columns. Only lossless repairs are applied here: a repair
// that would discard authored content — a textual column left without labeled
// actions, or valid actions beyond a smaller column's count — instead signals
// undeliverable (no columns) so callers send the textual fallback.
function normalizeCarouselColumns(columns: CarouselColumn[]): CarouselColumn[] {
  const normalized = columns.map((column) => {
    const result = normalizeCarouselColumnActions(column);
    result.actions = result.actions.filter(hasRenderableLabel);
    if (!result.text.trim() && result.title !== undefined) {
      // A blank column text adopts its title, mirroring the buttons path,
      // so the column's actions stay deliverable.
      result.text = result.title;
      result.title = undefined;
    }
    return result;
  });
  const isDeliverable = (column: CarouselColumn) =>
    column.actions.length > 0 && column.text.trim() !== "";
  const deliverable = normalized.filter(isDeliverable);
  // A column LINE cannot render still counts as content when it carries text
  // or a labeled action — the textual fallback can represent either — so
  // dropping it is lossy. Only a column with neither is omitted losslessly.
  const dropsContent =
    normalized.some(
      (column) =>
        !isDeliverable(column) && (column.text.trim() !== "" || column.actions.length > 0),
    ) || new Set(deliverable.map((column) => column.actions.length)).size > 1;
  if (deliverable.length === 0 || dropsContent) {
    return [];
  }
  const foldTitles = deliverable.some((column) => column.title === undefined);
  // A title dropped for cross-column consistency is folded into the text so
  // its content still reaches the user; the text limit is re-resolved because
  // it depends on title and thumbnail presence.
  const foldedText = (column: CarouselColumn): string =>
    foldTitles && column.title !== undefined ? `${column.title}: ${column.text}` : column.text;
  // Folding can push a thumbnail column's text past the 60-character image
  // cap; thumbnails are decoration with no textual form, so they are dropped
  // before any authored text is cut. The folded text always fits the
  // titleless, imageless 120 cap (title <= 40 + ": " + titled text <= 60).
  const dropThumbnails =
    deliverable.some((column) => column.thumbnailImageUrl === undefined) ||
    (foldTitles &&
      deliverable.some((column) => foldedText(column).length > COMPACT_TEMPLATE_TEXT_LIMIT));
  return deliverable.map((column) => {
    const title = foldTitles ? undefined : column.title;
    const thumbnailImageUrl = dropThumbnails ? undefined : column.thumbnailImageUrl;
    return Object.assign(column, {
      title,
      text: truncateTemplateText(
        foldedText(column),
        resolveTemplateTextLimit({ title, thumbnailImageUrl, textOnlyLimit: 120 }),
      ),
      thumbnailImageUrl,
    });
  });
}

/**
 * Create a confirm template (yes/no style dialog)
 */
export function createConfirmTemplate(
  text: string,
  confirmAction: Action,
  cancelAction: Action,
  altText?: string,
): TemplateMessage {
  const template: ConfirmTemplate = {
    type: "confirm",
    text: truncateTemplateText(text, 240), // LINE limit
    actions: [normalizeLineAction(confirmAction), normalizeLineAction(cancelAction)],
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(altText, text),
    template,
  };
}

/**
 * Create a button template with title, text, and action buttons
 */
export function createButtonTemplate(
  title: string | undefined,
  text: string,
  actions: Action[],
  options?: {
    thumbnailImageUrl?: string;
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    imageBackgroundColor?: string;
    defaultAction?: Action;
    altText?: string;
  },
): TemplateMessage {
  const normalizedTitle = title || undefined;
  const textLimit = resolveTemplateTextLimit({
    title: normalizedTitle,
    thumbnailImageUrl: options?.thumbnailImageUrl,
    textOnlyLimit: 160,
  });
  const template: ButtonsTemplate = {
    type: "buttons",
    ...(normalizedTitle ? { title: truncateTemplateText(normalizedTitle, 40) } : {}), // LINE limit
    text: truncateTemplateText(text, textLimit),
    actions: actions
      .map((action) => normalizeLineAction(action))
      .filter(hasRenderableLabel)
      .slice(0, 4), // LINE limit: max 4 actions
    thumbnailImageUrl: options?.thumbnailImageUrl,
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
    imageBackgroundColor: options?.imageBackgroundColor,
    defaultAction:
      options?.defaultAction === undefined ? undefined : normalizeLineAction(options.defaultAction),
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(
      options?.altText,
      normalizedTitle ? `${normalizedTitle}: ${text}` : text,
    ),
    template,
  };
}

/**
 * Create a carousel template with multiple columns.
 *
 * Columns are normalized to LINE's cross-column consistency rules with
 * lossless repairs only. When the input cannot be repaired without
 * discarding authored content, the result carries no columns — LINE rejects
 * an empty carousel exactly as it rejects the inconsistent input, so direct
 * callers keep provider-rejection semantics while
 * `buildTemplateMessageFromPayload` detects the empty template and degrades
 * to a content-complete text message instead.
 */
export function createTemplateCarousel(
  columns: CarouselColumn[],
  options?: {
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    altText?: string;
  },
): TemplateMessage {
  const template: CarouselTemplate = {
    type: "carousel",
    columns: normalizeCarouselColumns(columns.slice(0, 10)), // LINE limit: max 10 columns
    imageAspectRatio: options?.imageAspectRatio ?? "rectangle",
    imageSize: options?.imageSize ?? "cover",
  };

  return {
    type: "template",
    altText: resolveTemplateAltText(options?.altText, "View carousel"),
    template,
  };
}

/**
 * Create a carousel column for use with createTemplateCarousel
 */
export function createCarouselColumn(params: {
  title?: string;
  text: string;
  actions: Action[];
  thumbnailImageUrl?: string;
  imageBackgroundColor?: string;
  defaultAction?: Action;
}): CarouselColumn {
  const normalizedTitle = params.title || undefined;
  const thumbnailImageUrl = params.thumbnailImageUrl || undefined;
  // LINE caps a carousel column's text at 60 chars when the column carries a
  // title or thumbnail image, and 120 chars otherwise. Sending an over-length
  // text makes LINE reject the whole carousel, so mirror the conditional limit
  // the buttons template already applies above.
  const textLimit = resolveTemplateTextLimit({
    title: normalizedTitle,
    thumbnailImageUrl,
    textOnlyLimit: 120,
  });
  return {
    title: truncateOptionalTemplateText(normalizedTitle, 40),
    text: truncateTemplateText(params.text, textLimit),
    actions: params.actions.slice(0, 3).map((action) => normalizeLineAction(action)), // LINE limit: max 3 actions per column
    thumbnailImageUrl,
    imageBackgroundColor: params.imageBackgroundColor,
    defaultAction:
      params.defaultAction === undefined ? undefined : normalizeLineAction(params.defaultAction),
  };
}

// A degraded column must keep every user-visible part: title, text, and the
// labels of the actions the recipient can no longer tap.
// A whitespace-only altText carries nothing readable; treating it as present
// would let it suppress an authored question, title, or body in a fallback,
// or blank the fallback into a loud failure.
function authoredAltText(altText: string | undefined): string | undefined {
  return altText?.trim() ? altText : undefined;
}

// Surviving action labels are authored content; a textual fallback renders
// every non-blank one so degraded controls stay visible to the recipient.
function labeledActionSuffix(labels: Array<string | undefined>): string {
  const rendered = labels
    .map((label) => label?.trim())
    .filter((label): label is string => Boolean(label));
  return rendered.length ? `(${rendered.join(" / ")})` : "";
}

function describeCarouselColumn(column: CarouselColumn): string {
  const text = column.text.trim();
  const heading = column.title ? (text ? `${column.title}: ${text}` : column.title) : text;
  const suffix = labeledActionSuffix(column.actions.map((action) => action.label));
  return [heading, suffix].filter(Boolean).join(" ");
}

// A template that lost every button still carries user-visible content; LINE
// defines altText as exactly that textual representation, so deliver it as a
// plain text message instead of dropping the reply. A payload with nothing
// deliverable at all fails loudly — a silent skip would record a successful
// empty reply.
function templateTextFallback(text: string): TextMessage {
  if (!text.trim()) {
    throw new Error("LINE template payload has no deliverable text, actions, or altText.");
  }
  return { type: "text", text };
}

/**
 * Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage,
 * or to its textual fallback when LINE cannot render the template without
 * losing authored content.
 */
export function buildTemplateMessageFromPayload(
  payload: LineTemplateMessagePayload,
): TemplateMessage | TextMessage | null {
  switch (payload.type) {
    case "confirm": {
      // Confirm templates require two labeled actions and body text; a blank
      // value in any of them makes LINE reject the whole message. A confirm
      // cannot keep just one provider action, so the fallback carries any
      // surviving label alongside the question instead of dropping it.
      if (!payload.confirmLabel || !payload.cancelLabel || !payload.text.trim()) {
        const raw = authoredAltText(payload.altText) ?? payload.text;
        const base = raw.trim() ? truncateTemplateText(raw, TEMPLATE_ALT_TEXT_LIMIT) : "";
        const suffix = labeledActionSuffix([payload.confirmLabel, payload.cancelLabel]);
        return templateTextFallback([base, suffix].filter(Boolean).join(" "));
      }

      // Empty data means "tap sends the label", matching buildTemplatePayloadAction.
      const confirmData = payload.confirmData === "" ? payload.confirmLabel : payload.confirmData;
      const cancelData = payload.cancelData === "" ? payload.cancelLabel : payload.cancelData;

      const confirmAction = confirmData.startsWith("http")
        ? uriAction(payload.confirmLabel, confirmData)
        : confirmData.includes("=")
          ? postbackAction(payload.confirmLabel, confirmData, payload.confirmLabel)
          : messageAction(payload.confirmLabel, confirmData);

      const cancelAction = cancelData.startsWith("http")
        ? uriAction(payload.cancelLabel, cancelData)
        : cancelData.includes("=")
          ? postbackAction(payload.cancelLabel, cancelData, payload.cancelLabel)
          : messageAction(payload.cancelLabel, cancelData);

      return createConfirmTemplate(payload.text, confirmAction, cancelAction, payload.altText);
    }

    case "buttons": {
      const actions: Action[] = payload.actions.map((action) => buildTemplatePayloadAction(action));

      // LINE requires non-blank template text: a blank body folds the title
      // down into the text slot so the buttons stay deliverable.
      const title = payload.title?.trim() ? payload.title : undefined;
      const bodyText = payload.text.trim() ? payload.text : undefined;
      const text = bodyText ?? title;
      if (!text) {
        // No body and no title: the altText summary still cannot stand in
        // for the buttons themselves, so their labels ride along.
        const alt = authoredAltText(payload.altText);
        const base = alt === undefined ? "" : truncateTemplateText(alt, TEMPLATE_ALT_TEXT_LIMIT);
        const suffix = labeledActionSuffix(actions.map((action) => action.label));
        return templateTextFallback([base, suffix].filter(Boolean).join(" "));
      }
      // Only an actual fold drops the title slot; an authored title that
      // happens to match the text stays.
      const foldedTitle = bodyText ? title : undefined;

      const message = createButtonTemplate(foldedTitle, text, actions, {
        thumbnailImageUrl: payload.thumbnailImageUrl,
        altText: payload.altText,
      });
      if (message.template.type === "buttons" && message.template.actions.length === 0) {
        return templateTextFallback(
          truncateTemplateText(
            authoredAltText(payload.altText) ?? (foldedTitle ? `${foldedTitle}: ${text}` : text),
            TEMPLATE_ALT_TEXT_LIMIT,
          ),
        );
      }
      return message;
    }

    case "carousel": {
      const columns: CarouselColumn[] = payload.columns.slice(0, 10).map((col) => {
        const colActions: Action[] = col.actions
          .slice(0, 3)
          .map((action) => buildTemplatePayloadAction(action));

        return createCarouselColumn({
          title: col.title,
          text: col.text,
          thumbnailImageUrl: col.thumbnailImageUrl,
          actions: colActions,
        });
      });

      const message = createTemplateCarousel(columns, { altText: payload.altText });
      if (message.template.type === "carousel" && message.template.columns.length === 0) {
        // The altText is an authored summary, not a substitute for the column
        // content — an arbitrary "Two options" must not replace the columns'
        // text and action labels, so both are delivered.
        const lines = columns.map(describeCarouselColumn).filter(Boolean);
        const alt = authoredAltText(payload.altText);
        if (alt !== undefined) {
          lines.unshift(truncateTemplateText(alt, TEMPLATE_ALT_TEXT_LIMIT));
        }
        return templateTextFallback(lines.join("\n"));
      }
      return message;
    }

    default:
      return null;
  }
}

export type { TemplateMessage, ConfirmTemplate, ButtonsTemplate, CarouselTemplate, CarouselColumn };
