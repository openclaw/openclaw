/**
 * WeCom XML 解析器
 * 用于 Agent 模式解析 XML 格式消息
 */

import { XMLParser } from "fast-xml-parser";
import type { WecomAgentInboundMessage } from "../types/index.js";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
  processEntities: false,
});

/**
 * 解析 XML 字符串为消息对象
 */
export function parseXml(xml: string): WecomAgentInboundMessage {
  const obj = xmlParser.parse(xml);
  const root = obj?.xml ?? obj;
  return root ?? {};
}

/**
 * 从 XML 中提取消息类型
 */
export function extractMsgType(msg: WecomAgentInboundMessage): string {
  return String(msg.MsgType ?? "").toLowerCase();
}

/**
 * 从 XML 中提取发送者 ID
 */
export function extractFromUser(msg: WecomAgentInboundMessage): string {
  return String(msg.FromUserName ?? "");
}

/**
 * 从 XML 中提取文件名（主要用于 file 消息）
 */
export function extractFileName(msg: WecomAgentInboundMessage): string | undefined {
  const raw =
    (msg as any).FileName ??
    (msg as any).Filename ??
    (msg as any).fileName ??
    (msg as any).filename;
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint")
    return String(raw);
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
    if (text && text.trim()) return text.trim();
  }
  const s = String(raw);
  return s.trim() || undefined;
}

/**
 * 从 XML 中提取接收者 ID (CorpID)
 */
export function extractToUser(msg: WecomAgentInboundMessage): string {
  return String(msg.ToUserName ?? "");
}

/**
 * 从 XML 中提取群聊 ID
 */
export function extractChatId(msg: WecomAgentInboundMessage): string | undefined {
  return msg.ChatId ? String(msg.ChatId) : undefined;
}

/**
 * 从 XML 中提取消息内容
 */
export function extractContent(msg: WecomAgentInboundMessage): string {
  const msgType = extractMsgType(msg);

  const asText = (value: unknown): string => {
    if (value == null) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint")
      return String(value);
    if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
    if (typeof value === "object") {
      const obj = value as Record<string, unknown>;
      // fast-xml-parser 在某些情况下（例如带属性）会把文本放在 "#text"
      if (typeof obj["#text"] === "string") return obj["#text"];
      if (typeof obj["_text"] === "string") return obj["_text"];
      if (typeof obj["text"] === "string") return obj["text"];
      try {
        return JSON.stringify(obj);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };

  switch (msgType) {
    case "text":
      return asText(msg.Content);
    case "voice":
      // 语音识别结果
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
 * 从 XML 中提取媒体 ID (Image, Voice, Video)
 * 根据官方文档，MediaId 在 Agent 回调中直接位于根节点
 */
export function extractMediaId(msg: WecomAgentInboundMessage): string | undefined {
  const raw =
    (msg as any).MediaId ?? (msg as any).MediaID ?? (msg as any).mediaid ?? (msg as any).mediaId;
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint")
    return String(raw);
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
    if (text && text.trim()) return text.trim();
    try {
      const s = JSON.stringify(obj);
      return s.trim() || undefined;
    } catch {
      const s = String(raw);
      return s.trim() || undefined;
    }
  }
  const s = String(raw);
  return s.trim() || undefined;
}

/**
 * 从 XML 中提取 MsgId（用于去重）
 */
export function extractMsgId(msg: WecomAgentInboundMessage): string | undefined {
  const raw = (msg as any).MsgId ?? (msg as any).MsgID ?? (msg as any).msgid ?? (msg as any).msgId;
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "number" || typeof raw === "boolean" || typeof raw === "bigint")
    return String(raw);
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
    if (text && text.trim()) return text.trim();
    try {
      const s = JSON.stringify(obj);
      return s.trim() || undefined;
    } catch {
      const s = String(raw);
      return s.trim() || undefined;
    }
  }
  const s = String(raw);
  return s.trim() || undefined;
}
