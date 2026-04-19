/**
 * Link card message sub-handler.
 *
 * Handles TIMCustomElem messages with elem_type 1010 (share card) and 1007 (link understanding card),
 * formatting structured data as XML text for model comprehension and extracting link URLs for LinkUnderstanding.
 */

/** Max content truncation length */
const CONTENT_MAX_LENGTH = 1000;

// ============ 1010 Share card ============

interface SharedLinkData {
  elem_type: 1010;
  title?: string;
  desc?: string;
  link?: string;
  card_cover_url?: string;
  card_content?: string;
  wechat_des?: string;
  image_url?: string;
}

function isSharedLinkData(data: unknown): data is SharedLinkData {
  return typeof data === "object" && data !== null && (data as SharedLinkData).elem_type === 1010;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...(truncated)`;
}

function formatSharedLink(data: SharedLinkData): string {
  const lines: string[] = [];
  lines.push(`<share_card name="${data.title ?? ""}">`);
  if (data.link) {
    lines.push(`  <link>${data.link}</link>`);
  }
  if (data.card_content) {
    lines.push(
      `  <preview_title>${truncate(data.card_content, CONTENT_MAX_LENGTH)}</preview_title>`,
    );
  }
  if (data.wechat_des) {
    lines.push(
      `  <preview_description>${truncate(data.wechat_des, CONTENT_MAX_LENGTH)}</preview_description>`,
    );
  }
  lines.push(
    "  <instruction>以上仅为分享卡片的摘要预览，请访问 link 获取完整页面内容后再进行分析回复</instruction>",
  );
  lines.push("</share_card>");
  return lines.join("\n");
}

// ============ 1007 Link understanding card ============

interface LinkUnderstandingData {
  elem_type: 1007;
  extend_type?: number;
  content?: string;
}

function isLinkUnderstandingData(data: unknown): data is LinkUnderstandingData {
  return (
    typeof data === "object" && data !== null && (data as LinkUnderstandingData).elem_type === 1007
  );
}

function parseLinkFromContent(content: string): string | undefined {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed?.link === "string" ? parsed.link : undefined;
  } catch {
    return undefined;
  }
}

function formatLinkUnderstanding(data: LinkUnderstandingData): string | undefined {
  const link = data.content ? parseLinkFromContent(data.content) : undefined;
  if (!link) {
    return undefined;
  }
  const lines: string[] = [];
  lines.push("<link_understanding>");
  lines.push(`  <link>${link}</link>`);
  lines.push("  <instruction>请访问 link 获取完整页面内容后再进行分析回复</instruction>");
  lines.push("</link_understanding>");
  return lines.join("\n");
}

// ============ Public API ============

/**
 * Extract link card text representation (XML format) from custom message.
 */
export function extractLinkCard(customContent: unknown): string | undefined {
  if (isSharedLinkData(customContent)) {
    return formatSharedLink(customContent);
  }
  if (isLinkUnderstandingData(customContent)) {
    return formatLinkUnderstanding(customContent);
  }
  return undefined;
}

/**
 * Extract all link URLs from custom message (for LinkUnderstanding parameter).
 */
export function extractLinkCardUrls(customContent: unknown): string[] {
  if (isSharedLinkData(customContent) && customContent.link) {
    return [customContent.link];
  }
  if (isLinkUnderstandingData(customContent) && customContent.content) {
    const link = parseLinkFromContent(customContent.content);
    return link ? [link] : [];
  }
  return [];
}
