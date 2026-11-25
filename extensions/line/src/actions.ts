import type { messagingApi } from "@line/bot-sdk";
import { hasNonEmptyString, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  LINE_FLEX_BUBBLE_MAX_BYTES,
  LINE_FLEX_CAROUSEL_MAX_BYTES,
} from "./flex-templates/message.js";
import { isHttpsUrl } from "./media-url.js";

export type Action = messagingApi.Action;
type Message = messagingApi.Message;
type ImagemapAction = messagingApi.ImagemapAction;
type ImagemapVideo = messagingApi.ImagemapVideo;
const LINE_ACTION_LABEL_LIMIT = 20;
const LINE_QUICK_REPLY_ITEM_LIMIT = 13;
const lineActionUriProtocols = new Set(["http:", "https:", "line:", "tel:"]);
const linePostbackInputOptions = new Set([
  "closeRichMenu",
  "openRichMenu",
  "openKeyboard",
  "openVoice",
]);

const LINE_ACTION_DATA_LIMIT = 300;
const LINE_ACTION_URI_LIMIT = 1000;
const LINE_CLIPBOARD_TEXT_LIMIT = 1000;
const LINE_RICH_MENU_ALIAS_LIMIT = 32;
const LINE_IMAGEMAP_ACTION_LABEL_LIMIT = 100;
const LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT = 400;
const LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT = 30;
const LINE_IMAGEMAP_ACTION_LIMIT = 50;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isValidLineUri(value: unknown, icon = false): value is string {
  if (typeof value !== "string" || value.length > (icon ? 2000 : LINE_ACTION_URI_LIMIT)) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return icon ? protocol === "https:" : lineActionUriProtocols.has(protocol);
  } catch {
    return false;
  }
}

function invalidLineUriReason(value: unknown): string {
  return typeof value === "string" && value.length > LINE_ACTION_URI_LIMIT
    ? "URL exceeds LINE's limit."
    : "URL scheme is not supported by LINE.";
}

function isValidLinePickerValue(value: string, mode: string | undefined): boolean {
  if (mode === "time") {
    return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt]((?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(value);
  if (!match || (mode === "datetime") !== (match[4] !== undefined)) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1900 &&
    year <= 2100 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
function truncateLineActionText(text: string, limit: number): string {
  let result = "";
  let count = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const codePointCount = Array.from(segment).length;
    if (count + codePointCount > limit) {
      break;
    }
    result += segment;
    count += codePointCount;
  }
  return result;
}

export function truncateLineActionLabel(label: string, limit = LINE_ACTION_LABEL_LIMIT): string {
  const truncated = truncateLineActionText(label, limit);
  return truncated || (label ? "…" : "");
}

const UNDELIVERABLE_IMAGE_WARNING = "Image unavailable: URL must use HTTPS.";

function flexWarning(text: string): messagingApi.FlexText {
  return { type: "text", text, wrap: true, size: "sm", color: "#B45309", margin: "md" };
}

const unavailableActionMarker = Symbol("lineUnavailableAction");
type UnavailableAction = Extract<Action, { type: "message" }> & {
  [unavailableActionMarker]: true;
};

function unavailableAction(kind: "Action" | "Link", reason: string): Action {
  const action = {
    type: "message",
    label: "Unavailable",
    text: `${kind} unavailable: ${reason}`,
  } satisfies Action;
  Object.defineProperty(action, unavailableActionMarker, { value: true });
  return action;
}

const actionTypes = new Set([
  "camera",
  "cameraRoll",
  "clipboard",
  "datetimepicker",
  "location",
  "message",
  "postback",
  "richmenuswitch",
  "uri",
]);

function isLineAction(value: unknown): value is Action {
  return isRecord(value) && typeof value.type === "string" && actionTypes.has(value.type);
}

function isUnavailableAction(action: Action): action is UnavailableAction {
  return (action as Partial<UnavailableAction>)[unavailableActionMarker] === true;
}

type LineMessageActionSurface = "flex" | "template" | "image-carousel" | "quick-reply";

function hasRequiredActionFields(action: Action): boolean {
  switch (action.type) {
    case "message":
      return typeof action.text === "string";
    case "uri":
      return hasNonEmptyString(action.uri);
    case "postback":
      return typeof action.data === "string";
    case "datetimepicker":
      return (
        typeof action.data === "string" &&
        (action.mode === "date" || action.mode === "time" || action.mode === "datetime")
      );
    case "clipboard":
      return typeof action.clipboardText === "string" && action.clipboardText.length > 0;
    default:
      return true;
  }
}

function normalizeMessageSurfaceAction(
  value: unknown,
  labelLimit: number,
  surface: LineMessageActionSurface,
  requireLabel: boolean,
): Action {
  if (!isLineAction(value)) {
    return unavailableAction("Action", "action type is not supported by LINE.");
  }
  if (requireLabel && !hasNonEmptyString(value.label)) {
    return unavailableAction("Action", "action label is missing.");
  }
  if (value.type === "richmenuswitch") {
    return unavailableAction("Action", "rich menu switching is only available in rich menus.");
  }
  if (
    surface !== "quick-reply" &&
    (value.type === "camera" || value.type === "cameraRoll" || value.type === "location")
  ) {
    return unavailableAction("Action", "this action is only available in quick replies.");
  }
  if (surface === "quick-reply" && value.type === "postback" && value.text !== undefined) {
    const { text, ...postback } = value;
    return normalizeLineAction(
      { ...postback, displayText: postback.displayText ?? text },
      labelLimit,
    );
  }
  return normalizeLineAction(value, labelLimit);
}

function normalizeNestedContent(
  value: unknown,
  labelLimit: number,
  warnings?: string[],
  surface: LineMessageActionSurface = "flex",
): unknown {
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeNestedContent(item, labelLimit, warnings, surface))
      .filter((item) => item !== undefined);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (warnings && (value.type === "image" || value.type === "icon") && !isHttpsUrl(value.url)) {
    warnings.push(UNDELIVERABLE_IMAGE_WARNING);
    return undefined;
  }

  const normalized: Record<string, unknown> = { ...value };
  for (const [key, nested] of Object.entries(value)) {
    if ((key === "action" || key === "defaultAction") && nested !== undefined) {
      const requireLabel = surface === "template" || value.type === "button";
      const action = normalizeMessageSurfaceAction(nested, labelLimit, surface, requireLabel);
      if (key === "defaultAction" && isUnavailableAction(action)) {
        delete normalized[key];
        continue;
      }
      if (
        warnings &&
        key === "action" &&
        ((value.type === "video" && action.type !== "uri") ||
          (value.type !== "button" && isUnavailableAction(action)))
      ) {
        delete normalized[key];
        warnings.push(
          isUnavailableAction(action)
            ? (action.text ?? "Action unavailable.")
            : "Action unavailable in this video.",
        );
      } else {
        normalized[key] = action;
      }
    } else if (key === "actions" && Array.isArray(nested)) {
      normalized[key] = nested.map((action) =>
        normalizeMessageSurfaceAction(action, labelLimit, surface, surface === "template"),
      );
    } else {
      const content = normalizeNestedContent(nested, labelLimit, warnings, surface);
      if (content === undefined) {
        delete normalized[key];
      } else {
        normalized[key] = content;
      }
    }
  }
  if (warnings && value.type === "video") {
    // LINE requires a Box or Image alternative even when the video itself is valid.
    const altContent = normalized.altContent ?? {
      type: "box",
      layout: "vertical",
      contents: [flexWarning(UNDELIVERABLE_IMAGE_WARNING)],
    };
    if (!isHttpsUrl(value.url) || !isHttpsUrl(value.previewUrl)) {
      warnings.push("Video unavailable: video and preview URLs must use HTTPS.");
      return altContent;
    }
    normalized.altContent = altContent;
  }
  return normalized;
}

function normalizeFlexBubble(value: unknown, maxBytes = LINE_FLEX_BUBBLE_MAX_BYTES): unknown {
  if (!isRecord(value) || value.type !== "bubble") {
    return normalizeNestedContent(value, 40);
  }

  const warnings: string[] = [];
  const normalized = normalizeNestedContent(value, 40, warnings);
  if (!isRecord(normalized) || warnings.length === 0) {
    return normalized;
  }

  const warning = flexWarning([...new Set(warnings)].join("\n"));
  const body = normalized.body;
  const withWarning = {
    ...normalized,
    body:
      isRecord(body) && Array.isArray(body.contents)
        ? { ...body, contents: [...body.contents, warning] }
        : { type: "box", layout: "vertical", contents: [warning] },
  };
  // Removing a short invalid URL can save fewer bytes than its optional warning.
  // Keep the user's content deliverable within both bubble and carousel limits.
  return Buffer.byteLength(JSON.stringify(withWarning), "utf8") <=
    Math.min(maxBytes, LINE_FLEX_BUBBLE_MAX_BYTES)
    ? withWarning
    : normalized;
}

function normalizeFlexContainer(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (value.type === "bubble") {
    return normalizeFlexBubble(value);
  }
  if (value.type === "carousel" && Array.isArray(value.contents)) {
    let remainingBytes =
      LINE_FLEX_CAROUSEL_MAX_BYTES - Buffer.byteLength(JSON.stringify(value), "utf8");
    return {
      ...value,
      contents: value.contents.map((bubble) => {
        const originalBytes = Buffer.byteLength(JSON.stringify(bubble), "utf8");
        const normalized = normalizeFlexBubble(bubble, originalBytes + remainingBytes);
        remainingBytes += originalBytes - Buffer.byteLength(JSON.stringify(normalized), "utf8");
        return normalized;
      }),
    };
  }
  return normalizeNestedContent(value, 40);
}

function unavailableImagemapAction(
  kind: "Action" | "Link",
  reason: string,
  area: ImagemapAction["area"],
): ImagemapAction {
  return {
    type: "message",
    label: "Unavailable",
    text: `${kind} unavailable: ${reason}`,
    area,
  };
}

function normalizeImagemapAction(action: ImagemapAction): ImagemapAction {
  const label =
    action.label === undefined
      ? undefined
      : truncateLineActionText(action.label, LINE_IMAGEMAP_ACTION_LABEL_LIMIT);

  if (action.type === "uri") {
    if (!isValidLineUri(action.linkUri)) {
      return unavailableImagemapAction("Link", invalidLineUriReason(action.linkUri), action.area);
    }
    return { ...action, label };
  }

  if (action.type === "message") {
    if (typeof action.text !== "string") {
      return unavailableImagemapAction("Action", "message text is missing.", action.area);
    }
    if (action.text.length > LINE_IMAGEMAP_MESSAGE_TEXT_LIMIT) {
      return unavailableImagemapAction("Action", "message text exceeds LINE's limit.", action.area);
    }
    return { ...action, label };
  }

  if (typeof action.clipboardText !== "string" || action.clipboardText.length === 0) {
    return unavailableImagemapAction("Action", "clipboard text must not be empty.", action.area);
  }
  if (action.clipboardText.length > LINE_CLIPBOARD_TEXT_LIMIT) {
    return unavailableImagemapAction("Action", "clipboard text exceeds LINE's limit.", action.area);
  }
  return { ...action, label };
}

function normalizeImagemapVideo(video: ImagemapVideo): {
  video: ImagemapVideo;
  fallbackAction?: ImagemapAction;
} {
  const externalLink = video.externalLink;
  if (externalLink === undefined) {
    return { video };
  }

  if (
    !isRecord(externalLink) ||
    !isValidLineUri(externalLink.linkUri) ||
    !hasNonEmptyString(externalLink.label)
  ) {
    const normalizedVideo = { ...video };
    delete normalizedVideo.externalLink;
    return {
      video: normalizedVideo,
      fallbackAction:
        video.area === undefined
          ? undefined
          : unavailableImagemapAction("Link", "video link URL or label is invalid.", video.area),
    };
  }
  const label =
    truncateUtf16Safe(externalLink.label, LINE_IMAGEMAP_EXTERNAL_LINK_LABEL_LIMIT) || "…";
  return { video: { ...video, externalLink: { ...externalLink, label } } };
}

export function normalizeLineMessage(message: Message): Message {
  let normalized: Message;
  if (message.type === "flex") {
    normalized = {
      ...message,
      contents: normalizeFlexContainer(message.contents) as messagingApi.FlexContainer,
    };
  } else if (message.type === "template") {
    const labelLimit = message.template.type === "image_carousel" ? 12 : 20;
    const template = normalizeNestedContent(
      message.template,
      labelLimit,
      undefined,
      message.template.type === "image_carousel" ? "image-carousel" : "template",
    ) as messagingApi.Template;
    const columns =
      template.type === "carousel"
        ? template.columns
        : template.type === "buttons"
          ? [template]
          : [];
    // Template carousel columns must agree on image presence; a partial strip is invalid.
    if (columns.some((column) => !isHttpsUrl(column.thumbnailImageUrl))) {
      for (const column of columns) {
        delete column.thumbnailImageUrl;
      }
    }
    normalized = { ...message, template };
  } else if (message.type === "imagemap") {
    const actions = message.actions.map(normalizeImagemapAction);
    const videoResult = message.video ? normalizeImagemapVideo(message.video) : undefined;
    if (videoResult?.fallbackAction) {
      // At LINE's 50-action cap, silently drop the invalid video link so its
      // warning never displaces a valid action.
      if (actions.length < LINE_IMAGEMAP_ACTION_LIMIT) {
        actions.push(videoResult.fallbackAction);
      }
    }
    normalized = {
      ...message,
      actions,
      video: videoResult?.video,
    };
  } else {
    normalized = { ...message };
  }

  if (message.quickReply) {
    const items: messagingApi.QuickReplyItem[] = [];
    for (const item of Array.isArray(message.quickReply.items) ? message.quickReply.items : []) {
      if (
        !isRecord(item) ||
        !isLineAction(item.action) ||
        !hasNonEmptyString(item.action.label) ||
        !hasRequiredActionFields(item.action)
      ) {
        continue;
      }
      const { imageUrl, ...rest } = item;
      items.push({
        ...rest,
        ...(isValidLineUri(imageUrl, true) ? { imageUrl } : {}),
        type: "action",
        action: normalizeMessageSurfaceAction(item.action, 20, "quick-reply", true),
      });
      // Invalid items do not consume a provider slot.
      if (items.length === LINE_QUICK_REPLY_ITEM_LIMIT) {
        break;
      }
    }
    if (items.length) {
      normalized.quickReply = { items };
    } else {
      delete normalized.quickReply;
    }
  }

  return normalized;
}

export function normalizeLineAction(action: Action, labelLimit = LINE_ACTION_LABEL_LIMIT): Action {
  if (isUnavailableAction(action)) {
    return action;
  }
  const label =
    action.label === undefined ? undefined : truncateLineActionLabel(action.label, labelLimit);

  if (action.type === "uri") {
    if (!isValidLineUri(action.uri)) {
      return unavailableAction("Link", invalidLineUriReason(action.uri));
    }
    const normalized = { ...action, label };
    if (
      action.altUri !== undefined &&
      (!isRecord(action.altUri) || !isValidLineUri(action.altUri.desktop))
    ) {
      // Optional desktop metadata must not disable the primary link.
      delete normalized.altUri;
    }
    return normalized;
  }

  if (action.type === "postback" || action.type === "datetimepicker") {
    if (!hasRequiredActionFields(action)) {
      return unavailableAction("Action", "callback data or picker mode is missing.");
    }
    if (action.data !== undefined && action.data.length > LINE_ACTION_DATA_LIMIT) {
      // Callback data is opaque and echoed back by LINE. Never dispatch a value
      // whose identity changed merely to satisfy the transport cap.
      return unavailableAction("Action", "callback data exceeds LINE's limit.");
    }
    if (action.type === "datetimepicker") {
      const normalized = { ...action, label };
      for (const field of ["initial", "min", "max"] as const) {
        const value = normalized[field];
        if (value !== undefined && !isValidLinePickerValue(value, action.mode)) {
          delete normalized[field];
        }
      }
      if (
        normalized.min !== undefined &&
        normalized.max !== undefined &&
        normalized.min.toUpperCase() >= normalized.max.toUpperCase()
      ) {
        delete normalized.min;
        delete normalized.max;
      }
      return normalized;
    }
    const { text: legacyText, ...postback } = action;
    const chosenText = action.displayText === undefined ? legacyText : undefined;
    const text =
      chosenText === undefined
        ? undefined
        : truncateLineActionText(chosenText, LINE_ACTION_DATA_LIMIT);
    const keyboardText = action.inputOption === "openKeyboard" ? action.fillInText : undefined;
    const fillInText =
      keyboardText === undefined
        ? undefined
        : truncateLineActionText(keyboardText, LINE_ACTION_DATA_LIMIT);
    if (text !== chosenText || fillInText !== keyboardText) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    const normalized = {
      ...postback,
      label,
      displayText:
        action.displayText === undefined
          ? undefined
          : truncateLineActionText(action.displayText, LINE_ACTION_DATA_LIMIT),
      text,
      fillInText,
    };
    if (
      normalized.inputOption !== undefined &&
      !linePostbackInputOptions.has(normalized.inputOption)
    ) {
      delete normalized.inputOption;
    }
    if (normalized.inputOption !== "openKeyboard") {
      delete normalized.fillInText;
    }
    return normalized;
  }

  if (action.type === "message") {
    if (!hasRequiredActionFields(action)) {
      return unavailableAction("Action", "message text is missing.");
    }
    const text =
      action.text === undefined
        ? undefined
        : truncateLineActionText(action.text, LINE_ACTION_DATA_LIMIT);
    if (text !== action.text) {
      return unavailableAction("Action", "message text exceeds LINE's limit.");
    }
    return {
      ...action,
      label,
      text,
    };
  }

  if (action.type === "clipboard") {
    if (!hasRequiredActionFields(action)) {
      return unavailableAction("Action", "clipboard text must not be empty.");
    }
    if (action.clipboardText.length > LINE_CLIPBOARD_TEXT_LIMIT) {
      return unavailableAction("Action", "clipboard text exceeds LINE's limit.");
    }
    return { ...action, label };
  }

  if (action.type === "richmenuswitch") {
    const dataTooLong = action.data !== undefined && action.data.length > LINE_ACTION_DATA_LIMIT;
    const aliasTooLong =
      action.richMenuAliasId !== undefined &&
      action.richMenuAliasId.length > LINE_RICH_MENU_ALIAS_LIMIT;
    if (dataTooLong || aliasTooLong) {
      return unavailableAction("Action", "rich menu data exceeds LINE's limit.");
    }
    return { ...action, label };
  }

  return action.label === label ? action : { ...action, label };
}

export function messageAction(label: string, text?: string): Action {
  return normalizeLineAction({
    type: "message",
    label,
    text: text ?? label,
  });
}

export function uriAction(label: string, uri: string): Action {
  return normalizeLineAction({
    type: "uri",
    label,
    uri,
  });
}

export function postbackAction(label: string, data: string, displayText?: string): Action {
  return normalizeLineAction({
    type: "postback",
    label,
    data,
    displayText,
  });
}
