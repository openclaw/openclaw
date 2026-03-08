/**
 * WeCom XML Parser
 *
 * Simple regex-based parser for Agent mode XML callbacks.
 * No external dependencies — WeCom XML has a flat, predictable structure.
 *
 * Typical decrypted XML:
 *   <xml>
 *     <ToUserName><![CDATA[corpId]]></ToUserName>
 *     <FromUserName><![CDATA[zhangsan]]></FromUserName>
 *     <CreateTime>1348831860</CreateTime>
 *     <MsgType><![CDATA[text]]></MsgType>
 *     <Content><![CDATA[hello]]></Content>
 *     <MsgId>1234567890123456</MsgId>
 *     <AgentID>1000002</AgentID>
 *   </xml>
 */

/**
 * Extract the <Encrypt> field from the outer XML envelope.
 * Supports both CDATA and plain text formats.
 *
 * @param {string} xml - Raw XML string from WeCom POST body
 * @returns {string} The encrypted payload
 */
export function extractEncryptFromXml(xml) {
  const cdataMatch = /<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s.exec(xml);
  if (cdataMatch?.[1]) return cdataMatch[1];

  const plainMatch = /<Encrypt>(.*?)<\/Encrypt>/s.exec(xml);
  if (plainMatch?.[1]) return plainMatch[1];

  throw new Error("Invalid XML: missing Encrypt field");
}

/**
 * Parse a decrypted WeCom XML message into a flat key-value object.
 * Handles both CDATA-wrapped and plain text values.
 *
 * @param {string} xml - Decrypted XML string
 * @returns {Record<string, string>}
 */
export function parseXml(xml) {
  const result = {};

  // Match <TagName><![CDATA[value]]></TagName> (CDATA)
  const cdataRegex = /<(\w+)><!\[CDATA\[([\s\S]*?)\]\]><\/\1>/g;
  let match;
  while ((match = cdataRegex.exec(xml)) !== null) {
    result[match[1]] = match[2];
  }

  // Match <TagName>value</TagName> (plain text, skip already-captured CDATA fields)
  const plainRegex = /<(\w+)>([^<]+)<\/\1>/g;
  while ((match = plainRegex.exec(xml)) !== null) {
    if (!(match[1] in result)) {
      result[match[1]] = match[2].trim();
    }
  }

  return result;
}

/** Extract message type (lowercase). */
export function extractMsgType(msg) {
  return String(msg.MsgType ?? "").toLowerCase();
}

/** Extract sender user ID. */
export function extractFromUser(msg) {
  return String(msg.FromUserName ?? "");
}

/** Extract group chat ID (undefined for DMs). */
export function extractChatId(msg) {
  return msg.ChatId ? String(msg.ChatId) : undefined;
}

/** Extract message ID for deduplication. */
export function extractMsgId(msg) {
  const raw = msg.MsgId ?? msg.MsgID ?? msg.msgid ?? msg.msgId;
  return raw != null ? String(raw) : undefined;
}

/** Extract file name (for file messages). */
export function extractFileName(msg) {
  const raw = msg.FileName ?? msg.Filename ?? msg.fileName ?? msg.filename;
  return raw != null ? String(raw).trim() || undefined : undefined;
}

/** Extract media ID (for image/voice/video/file messages). */
export function extractMediaId(msg) {
  const raw = msg.MediaId ?? msg.MediaID ?? msg.mediaid ?? msg.mediaId;
  return raw != null ? String(raw).trim() || undefined : undefined;
}

/**
 * Extract human-readable content from a parsed message.
 *
 * @param {Record<string, string>} msg - Parsed XML message
 * @returns {string}
 */
export function extractContent(msg) {
  const msgType = extractMsgType(msg);

  switch (msgType) {
    case "text":
      return String(msg.Content ?? "");
    case "voice":
      return String(msg.Recognition ?? "") || "[语音消息]";
    case "image":
      return `[图片] ${msg.PicUrl ?? ""}`;
    case "file":
      return "[文件消息]";
    case "video":
      return "[视频消息]";
    case "location":
      return `[位置] ${msg.Label ?? ""} (${msg.Location_X ?? ""}, ${msg.Location_Y ?? ""})`;
    case "link":
      return `[链接] ${msg.Title ?? ""}\n${msg.Description ?? ""}\n${msg.Url ?? ""}`;
    case "event":
      return `[事件] ${msg.Event ?? ""} - ${msg.EventKey ?? ""}`;
    default:
      return `[${msgType || "未知消息类型"}]`;
  }
}
