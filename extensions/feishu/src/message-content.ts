import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { escapeHtml, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { parseInteractiveCardContent } from "./interactive-message-content.js";
import { renderPostContent } from "./post.js";

export type MergeForwardMessageItem = {
  msg_type?: string;
  body?: { content?: string };
  upper_message_id?: string;
  create_time?: string;
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
  };
};

export type ParseMergeForwardContentOptions = {
  /** Display names keyed by sender id (open_id / user_id / union_id). */
  senderNames?: ReadonlyMap<string, string>;
};

export function formatFeishuMediaContent(
  parsed: Record<string, unknown>,
  messageType: string,
): string {
  if (messageType === "sticker") {
    const fileKey = normalizeFeishuExternalKey(parsed?.file_key);
    return fileKey ? `<sticker key="${escapeHtml(fileKey)}"/>` : "[Sticker]";
  }
  const speechToText =
    messageType === "audio" && typeof parsed.speech_to_text === "string"
      ? parsed.speech_to_text.trim()
      : "";
  if (speechToText) {
    return speechToText;
  }
  return "";
}

function formatSubMessageContent(content: string, contentType: string): string {
  try {
    const parsed = JSON.parse(content);
    switch (contentType) {
      case "text":
        return parsed.text || content;
      case "post":
        return renderPostContent(parsed).textContent;
      case "interactive":
        return parseInteractiveCardContent(parsed);
      case "image":
        return "[Image]";
      case "file":
        return `[File: ${parsed.file_name || "unknown"}]`;
      case "audio":
        return "[Audio]";
      case "video":
        return "[Video]";
      case "sticker":
        return formatFeishuMediaContent(parsed, contentType);
      case "merge_forward":
        return "[Nested Merged Forward]";
      default:
        return `[${contentType}]`;
    }
  } catch {
    return content;
  }
}

function formatMergeForwardCreateTime(createTime?: string): string | undefined {
  const createTimeMs = parseStrictNonNegativeInteger(createTime);
  if (createTimeMs === undefined) {
    return undefined;
  }
  const date = new Date(createTimeMs);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString();
}

function formatMergeForwardSenderLabel(
  item: MergeForwardMessageItem,
  senderNames?: ReadonlyMap<string, string>,
): string | undefined {
  const senderId = item.sender?.id?.trim();
  if (!senderId) {
    return undefined;
  }
  return senderNames?.get(senderId) ?? senderId;
}

function formatMergeForwardLine(
  item: MergeForwardMessageItem,
  senderNames?: ReadonlyMap<string, string>,
): string {
  const body = formatSubMessageContent(item.body?.content || "", item.msg_type || "text");
  const time = formatMergeForwardCreateTime(item.create_time);
  const sender = formatMergeForwardSenderLabel(item, senderNames);
  const prefix = [time ? `[${time}]` : undefined, sender ? `${sender}:` : undefined]
    .filter(Boolean)
    .join(" ");
  return prefix ? `- ${prefix} ${body}` : `- ${body}`;
}

export function parseMergeForwardContent(
  items: ReadonlyArray<MergeForwardMessageItem>,
  options?: ParseMergeForwardContentOptions,
): string {
  const maxMessages = 50;
  if (items.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages]";
  }
  const container = items.find(
    (item) => item.msg_type === "merge_forward" && !item.upper_message_id,
  );
  const subMessages = container
    ? items.filter((item) => item !== container)
    : items.filter((item) => item.upper_message_id);
  if (subMessages.length === 0) {
    return "[Merged and Forwarded Message - no sub-messages found]";
  }
  subMessages.sort(
    (a, b) =>
      (parseStrictNonNegativeInteger(a.create_time) ?? 0) -
      (parseStrictNonNegativeInteger(b.create_time) ?? 0),
  );

  const lines = ["[Merged and Forwarded Messages]"];
  for (const item of subMessages.slice(0, maxMessages)) {
    lines.push(formatMergeForwardLine(item, options?.senderNames));
  }
  if (subMessages.length > maxMessages) {
    lines.push(`... and ${subMessages.length - maxMessages} more messages`);
  }
  const rendered = lines.join("\n");
  const maxContentChars = 20_000;
  const marker = "\n... [Merged-forward content truncated]";
  return rendered.length <= maxContentChars
    ? rendered
    : `${truncateUtf16Safe(rendered, maxContentChars - marker.length).trimEnd()}${marker}`;
}
