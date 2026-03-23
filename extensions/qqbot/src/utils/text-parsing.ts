/**
 * QQ Bot 文本解析工具函数
 */

import type { RefAttachmentSummary } from "../ref-index-store.js";

/**
 * 解析 QQ 表情标签，将 <faceType=1,faceId="13",ext="base64..."> 格式
 * 替换为 【表情: 中文名】 格式
 * ext 字段为 Base64 编码的 JSON，格式如 {"text":"呲牙"}
 */
export function parseFaceTags(text: string): string {
  if (!text) return text;

  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_match, ext: string) => {
    try {
      const decoded = Buffer.from(ext, "base64").toString("utf-8");
      const parsed = JSON.parse(decoded);
      const faceName = parsed.text || "未知表情";
      return `【表情: ${faceName}】`;
    } catch {
      return _match;
    }
  });
}

/**
 * 过滤内部标记（如 [[reply_to: xxx]]）
 * 这些标记可能被 AI 错误地学习并输出，需要在发送前移除
 */
export function filterInternalMarkers(text: string): string {
  if (!text) return text;

  let result = text.replace(/\[\[[a-z_]+:\s*[^\]]*\]\]/gi, "");
  // 过滤框架内部图片引用标记：@image:image_xxx.png、@voice:voice_xxx.silk 等
  result = result.replace(/@(?:image|voice|video|file):[a-zA-Z0-9_.-]+/g, "");
  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return result;
}

/**
 * 从 message_scene.ext 数组中解析引用索引
 * ext 格式示例: ["", "ref_msg_idx=REFIDX_xxx", "msg_idx=REFIDX_yyy"]
 */
export function parseRefIndices(ext?: string[]): { refMsgIdx?: string; msgIdx?: string } {
  if (!ext || ext.length === 0) return {};
  let refMsgIdx: string | undefined;
  let msgIdx: string | undefined;
  for (const item of ext) {
    if (item.startsWith("ref_msg_idx=")) {
      refMsgIdx = item.slice("ref_msg_idx=".length);
    } else if (item.startsWith("msg_idx=")) {
      msgIdx = item.slice("msg_idx=".length);
    }
  }
  return { refMsgIdx, msgIdx };
}

/**
 * 从附件列表中构建附件摘要（用于引用索引缓存）
 */
export function buildAttachmentSummaries(
  attachments?: Array<{
    content_type: string;
    url: string;
    filename?: string;
    voice_wav_url?: string;
  }>,
  localPaths?: Array<string | null>,
): RefAttachmentSummary[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((att, idx) => {
    const ct = att.content_type?.toLowerCase() ?? "";
    let type: RefAttachmentSummary["type"] = "unknown";
    if (ct.startsWith("image/")) type = "image";
    else if (ct === "voice" || ct.startsWith("audio/") || ct.includes("silk") || ct.includes("amr"))
      type = "voice";
    else if (ct.startsWith("video/")) type = "video";
    else if (ct.startsWith("application/") || ct.startsWith("text/")) type = "file";
    return {
      type,
      filename: att.filename,
      contentType: att.content_type,
      localPath: localPaths?.[idx] ?? undefined,
    };
  });
}
