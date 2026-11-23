import type { messagingApi } from "@line/bot-sdk";
import { findGraphemeChunkEnd } from "openclaw/plugin-sdk/text-grapheme";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { messageAction, postbackAction, uriAction, type Action } from "./actions.js";
import type {
  LineChannelData,
  LineTemplateActionPayload,
  LineTemplateMessagePayload,
} from "./types.js";

type TemplateMessage = messagingApi.TemplateMessage;
type TextMessage = messagingApi.TextMessage;
type LocationMessage = messagingApi.LocationMessage;
type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;
type LineLocation = NonNullable<LineChannelData["location"]>;
type CarouselColumn = messagingApi.CarouselColumn;

const COMPACT_TEMPLATE_TEXT_LIMIT = 60;
const TEMPLATE_ALT_TEXT_LIMIT = 1500;
const LINE_FLEX_ALT_TEXT_LIMIT = 1500;
const LINE_LOCATION_LABEL_LIMIT = 100;

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

function resolveTemplateTextLimit(
  title: string | undefined,
  thumbnailImageUrl: string | undefined,
  textOnlyLimit: number,
): number {
  return title !== undefined || thumbnailImageUrl !== undefined
    ? COMPACT_TEMPLATE_TEXT_LIMIT
    : textOnlyLimit;
}

function truncateTemplateText(text: string, limit: number): string {
  const end = findGraphemeChunkEnd(text, 0, limit, limit, false);
  // Required text still needs a surrogate-safe prefix when its first grapheme exceeds the cap.
  return end > 0 ? text.slice(0, end) : truncateUtf16Safe(text, limit);
}

function resolveTemplateAltText(value: string | undefined, fallback: string): string {
  return truncateTemplateText(value ?? fallback, TEMPLATE_ALT_TEXT_LIMIT);
}

export function createLocationMessage(location: LineLocation): LocationMessage | TextMessage {
  // LINE rejects blank labels atomically. Keep the authored text and coordinates,
  // bounded by the same label cap, when the location cannot render as a pin.
  if (!location.title.trim() || !location.address.trim()) {
    const authored = [location.title, location.address]
      .map((label) => truncateUtf16Safe(label.trim(), LINE_LOCATION_LABEL_LIMIT))
      .filter(Boolean);
    return {
      type: "text",
      text: [...authored, `${location.latitude}, ${location.longitude}`].join("\n"),
    };
  }
  return {
    type: "location",
    title: truncateUtf16Safe(location.title, LINE_LOCATION_LABEL_LIMIT),
    address: truncateUtf16Safe(location.address, LINE_LOCATION_LABEL_LIMIT),
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

export function createFlexMessage(
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: truncateUtf16Safe(altText, LINE_FLEX_ALT_TEXT_LIMIT),
    contents,
  };
}

export function createQuickReplyItems(labels: string[]): QuickReply {
  const items: QuickReplyItem[] = labels
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 13)
    .map((label) => ({
      type: "action",
      action: messageAction(label, label),
    }));
  return { items };
}

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
      const textLimit = resolveTemplateTextLimit(title, payload.thumbnailImageUrl, 160);
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
        const textLimit = resolveTemplateTextLimit(title, column.thumbnailImageUrl, 120);
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
      const visibleColumns = columns.slice(0, 10);
      const first = visibleColumns[0];
      // Thumbnail consistency belongs to normalizeLineMessage; only text and
      // action shape can require a plain-text fallback here.
      if (
        !first ||
        visibleColumns.some(
          (column) =>
            column.text === "" ||
            column.actions.length === 0 ||
            (column.title === undefined) !== (first.title === undefined) ||
            column.actions.length !== first.actions.length,
        )
      ) {
        const text = [
          ...(payload.altText
            ? [truncateTemplateText(payload.altText, TEMPLATE_ALT_TEXT_LIMIT)]
            : []),
          ...visibleColumns
            .map((column) => {
              const body = column.title ? `${column.title}: ${column.text}` : column.text;
              const labels = column.actions
                .map((action) => action.label)
                .filter((label) => label !== undefined && label !== "");
              return labels.length > 0 ? `${body} (${labels.join(" / ")})` : body;
            })
            .filter((line) => line !== ""),
        ].join("\n");
        // An empty carousel contributes nothing; other parts of the reply can still send.
        return text ? { type: "text", text } : null;
      }
      return {
        type: "template",
        altText: resolveTemplateAltText(payload.altText, "View carousel"),
        template: {
          type: "carousel",
          columns: visibleColumns,
          imageAspectRatio: "rectangle",
          imageSize: "cover",
        },
      };
    }

    default:
      return null;
  }
}
