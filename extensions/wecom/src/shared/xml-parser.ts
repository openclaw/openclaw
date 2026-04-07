/**
 * WeCom XML parser
 * Used in Agent mode to parse XML-format messages
 */

import { XMLParser } from "fast-xml-parser";
import type { WecomAgentInboundMessage } from "../types/index.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
});

/**
 * Parses an XML string into a message object
 */
export function parseXml(xml: string): WecomAgentInboundMessage {
  const obj = xmlParser.parse(xml);
  const root = obj?.xml ?? obj;
  return root ?? {};
}

/**
 * Extracts the message type from XML
 */
export function extractMsgType(msg: WecomAgentInboundMessage): string {
  return String(msg.MsgType ?? "").toLowerCase();
}

/**
 * Extracts the sender ID from XML
 */
export function extractFromUser(msg: WecomAgentInboundMessage): string {
  return String(msg.FromUserName ?? "");
}

/**
 * Extracts the filename from XML (primarily used for file messages)
 */
export function extractFileName(msg: WecomAgentInboundMessage): string | undefined {
  const raw =
    (msg as unknown as Record<string, unknown>).FileName ??
    (msg as unknown as Record<string, unknown>).Filename ??
    (msg as unknown as Record<string, unknown>).fileName ??
    (msg as unknown as Record<string, unknown>).filename;
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    const merged = raw
      .map((v) => (v == null ? "" : String(v)))
      .join("\n")
      .trim();
    return merged || undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text =
      typeof obj["#text"] === "string"
        ? obj["#text"]
        : typeof obj["_text"] === "string"
          ? obj["_text"]
          : typeof obj["text"] === "string"
            ? obj["text"]
            : undefined;
    if (text && text.trim()) {
      return text.trim();
    }
  }
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
  const s = String(raw);
  return s.trim() || undefined;
}

/**
 * Extracts the receiver ID (CorpID) from XML
 */
export function extractToUser(msg: WecomAgentInboundMessage): string {
  return String(msg.ToUserName ?? "");
}

/**
 * Extracts the group chat ID from XML
 */
export function extractChatId(msg: WecomAgentInboundMessage): string | undefined {
  return msg.ChatId ? String(msg.ChatId) : undefined;
}

/**
 * Extracts the AgentID from XML (compatible with AgentID/agentid and other case variants)
 */
export function extractAgentId(msg: WecomAgentInboundMessage): string | number | undefined {
  const raw =
    (msg as unknown as Record<string, unknown>).AgentID ??
    (msg as unknown as Record<string, unknown>).AgentId ??
    (msg as unknown as Record<string, unknown>).agentid ??
    (msg as unknown as Record<string, unknown>).agentId;
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "number") {
    return raw;
  }
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
  const asString = String(raw).trim();
  return asString || undefined;
}

/**
 * Extracts the message content from XML
 */
export function extractContent(msg: WecomAgentInboundMessage): string {
  const msgType = extractMsgType(msg);

  const asText = (value: unknown): string => {
    if (value == null) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map(asText).filter(Boolean).join("\n");
    }
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // fast-xml-parser may put text in "#text" in certain cases (e.g. with attributes)
      if (typeof obj["#text"] === "string") {
        return obj["#text"];
      }
      if (typeof obj["_text"] === "string") {
        return obj["_text"];
      }
      if (typeof obj["text"] === "string") {
        return obj["text"];
      }
      try {
        return JSON.stringify(obj);
      } catch {
        // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
        return String(value);
      }
    }
    // oxlint-disable-next-line typescript/no-base-to-string -- SDK response fields have unknown shape
    return String(value);
  };

  switch (msgType) {
    case "text":
      return asText(msg.Content);
    case "voice":
      // Voice recognition result
      return asText(msg.Recognition) || "[语音消息]";
    case "image":
      return `[图片] ${asText(msg.PicUrl)}`;
    case "file":
      return "[文件消息]";
    case "video":
      return "[视频消息]";
    case "location":
      return `[位置] ${asText(msg.Label)} (${asText(msg.Location_X)}, ${asText(msg.Location_Y)})`;
    case "link":
      return `[链接] ${asText(msg.Title)}\n${asText(msg.Description)}\n${asText(msg.Url)}`;
    case "event":
      return `[事件] ${asText(msg.Event)} - ${asText(msg.EventKey)}`;
    default:
      return `[${msgType || "未知消息类型"}]`;
  }
}

/**
 * Extracts the Media ID from XML (Image, Voice, Video)
 * According to official docs, MediaId is directly under the root node in Agent callbacks
 */
export function extractMediaId(msg: WecomAgentInboundMessage): string | undefined {
  const raw =
    (msg as unknown as Record<string, unknown>).MediaId ??
    (msg as unknown as Record<string, unknown>).MediaID ??
    (msg as unknown as Record<string, unknown>).mediaid ??
    (msg as unknown as Record<string, unknown>).mediaId;
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    const merged = raw
      .map((v) => (v == null ? "" : String(v)))
      .join("\n")
      .trim();
    return merged || undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text =
      typeof obj["#text"] === "string"
        ? obj["#text"]
        : typeof obj["_text"] === "string"
          ? obj["_text"]
          : typeof obj["text"] === "string"
            ? obj["text"]
            : undefined;
    if (text && text.trim()) {
      return text.trim();
    }
    try {
      const s = JSON.stringify(obj);
      return s.trim() || undefined;
    } catch {
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
      const s = String(raw);
      return s.trim() || undefined;
    }
  }
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
  const s = String(raw);
  return s.trim() || undefined;
}

/**
 * Extracts MsgId from XML (used for deduplication)
 */
export function extractMsgId(msg: WecomAgentInboundMessage): string | undefined {
  const raw =
    (msg as unknown as Record<string, unknown>).MsgId ??
    (msg as unknown as Record<string, unknown>).MsgID ??
    (msg as unknown as Record<string, unknown>).msgid ??
    (msg as unknown as Record<string, unknown>).msgId;
  if (raw == null) {
    return undefined;
  }
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint") {
    return String(raw);
  }
  if (Array.isArray(raw)) {
    const merged = raw
      .map((v) => (v == null ? "" : String(v)))
      .join("\n")
      .trim();
    return merged || undefined;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const text =
      typeof obj["#text"] === "string"
        ? obj["#text"]
        : typeof obj["_text"] === "string"
          ? obj["_text"]
          : typeof obj["text"] === "string"
            ? obj["text"]
            : undefined;
    if (text && text.trim()) {
      return text.trim();
    }
    try {
      const s = JSON.stringify(obj);
      return s.trim() || undefined;
    } catch {
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
      const s = String(raw);
      return s.trim() || undefined;
    }
  }
    // oxlint-disable-next-line typescript/no-base-to-string -- best-effort stringification of dynamic SDK data
  const s = String(raw);
  return s.trim() || undefined;
}
