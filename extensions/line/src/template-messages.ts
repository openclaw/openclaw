import type { messagingApi } from "@line/bot-sdk";
import { messageAction, postbackAction, uriAction, type Action } from "./actions.js";
import type { LineTemplateActionPayload, LineTemplateMessagePayload } from "./types.js";

type TemplateMessage = messagingApi.TemplateMessage;
type TextMessage = messagingApi.TextMessage;
type CarouselColumn = messagingApi.CarouselColumn;

const COMPACT_TEMPLATE_TEXT_LIMIT = 60;
const TEMPLATE_ALT_TEXT_LIMIT = 1500;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function buildTemplatePayloadAction(action: LineTemplateActionPayload): Action {
  if (action.type === "uri" && action.uri) {
    return uriAction(action.label, action.uri);
  }
  if (action.type === "postback" && action.data) {
    return postbackAction(action.label, action.data, action.label);
  }
  return messageAction(action.label, action.data ?? action.label);
}

function buildInferredTemplateAction(label: string, data: string): Action {
  return data.startsWith("http")
    ? uriAction(label, data)
    : data.includes("=")
      ? postbackAction(label, data, label)
      : messageAction(label, data);
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

function resolveTemplateAltText(value: string | undefined, fallback: string): string {
  return truncateTemplateText(value ?? fallback, TEMPLATE_ALT_TEXT_LIMIT);
}

type CarouselNormalizationOutcome =
  | { kind: "template"; columns: CarouselColumn[] }
  | { kind: "text"; text: string }
  // A carousel that carries neither a column nor alt text. It is a distinct
  // outcome rather than a throw because a reply can hold one beside ordinary
  // text: aborting here would take that text down with it, while a builder
  // that asked for a carousel still has nothing to return.
  | { kind: "empty" };

function describeCarouselColumn(column: CarouselColumn): string {
  const body = column.title ? `${column.title}: ${column.text}` : column.text;
  const labels = column.actions
    .map((action) => action.label)
    .filter((label): label is string => label !== undefined && label !== "");
  return labels.length > 0 ? `${body} (${labels.join(" / ")})` : body;
}

function normalizeCarousel(
  columns: CarouselColumn[],
  altText?: string,
): CarouselNormalizationOutcome {
  const normalized = columns.slice(0, 10);
  const first = normalized[0];
  // Thumbnails are deliberately not part of this check. Outbound normalization
  // already strips every column's image when one of them is unusable
  // (`normalizeLineMessage` in actions.ts), which satisfies LINE's all-or-none
  // rule; degrading the carousel to text here would throw away a card that
  // owner still delivers.
  const invalid =
    !first ||
    normalized.some(
      (column) =>
        column.text === "" ||
        column.actions.length === 0 ||
        (column.title === undefined) !== (first.title === undefined) ||
        column.actions.length !== first.actions.length,
    );
  if (!invalid) {
    return { kind: "template", columns: normalized };
  }

  const text = [
    ...(altText ? [truncateTemplateText(altText, TEMPLATE_ALT_TEXT_LIMIT)] : []),
    ...normalized.map(describeCarouselColumn).filter((line) => line !== ""),
  ].join("\n");
  return text ? { kind: "text", text } : { kind: "empty" };
}

/** Convert portable template payloads at the LINE provider boundary. */
export function buildTemplateMessageFromPayload(
  payload: LineTemplateMessagePayload,
): TemplateMessage | TextMessage | null {
  switch (payload.type) {
    case "confirm":
      return {
        type: "template",
        altText: resolveTemplateAltText(payload.altText, payload.text),
        template: {
          type: "confirm",
          text: truncateTemplateText(payload.text, 240),
          actions: [
            buildInferredTemplateAction(payload.confirmLabel, payload.confirmData),
            buildInferredTemplateAction(payload.cancelLabel, payload.cancelData),
          ],
        },
      };

    case "buttons": {
      const title = payload.title || undefined;
      const textLimit = resolveTemplateTextLimit({
        title,
        thumbnailImageUrl: payload.thumbnailImageUrl,
        textOnlyLimit: 160,
      });
      return {
        type: "template",
        altText: resolveTemplateAltText(
          payload.altText,
          title ? `${title}: ${payload.text}` : payload.text,
        ),
        template: {
          type: "buttons",
          ...(title ? { title: truncateTemplateText(title, 40) } : {}),
          text: truncateTemplateText(payload.text, textLimit),
          actions: payload.actions.slice(0, 4).map(buildTemplatePayloadAction),
          thumbnailImageUrl: payload.thumbnailImageUrl,
          imageAspectRatio: "rectangle",
          imageSize: "cover",
          imageBackgroundColor: undefined,
          defaultAction: undefined,
        },
      };
    }

    case "carousel": {
      const columns = payload.columns.map((column): CarouselColumn => {
        const title = column.title || undefined;
        const textLimit = resolveTemplateTextLimit({
          title,
          thumbnailImageUrl: column.thumbnailImageUrl,
          textOnlyLimit: 120,
        });
        return {
          title: title === undefined ? undefined : truncateTemplateText(title, 40),
          text: truncateTemplateText(column.text, textLimit),
          actions: column.actions
            .map(buildTemplatePayloadAction)
            .filter((action) => action.label !== undefined && action.label !== "")
            .slice(0, 3),
          thumbnailImageUrl: column.thumbnailImageUrl,
          imageBackgroundColor: undefined,
          defaultAction: undefined,
        };
      });
      const outcome = normalizeCarousel(columns, payload.altText);
      if (outcome.kind === "empty") {
        // An empty carousel contributes nothing; other parts of the reply can still send.
        return null;
      }
      return outcome.kind === "text"
        ? { type: "text", text: outcome.text }
        : {
            type: "template",
            altText: resolveTemplateAltText(payload.altText, "View carousel"),
            template: {
              type: "carousel",
              columns: outcome.columns,
              imageAspectRatio: "rectangle",
              imageSize: "cover",
            },
          };
    }

    default:
      return null;
  }
}
